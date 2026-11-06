"""Code Visualizer server: serves the page and traces Java and C++ programs.

Python runs entirely in the browser; this server is only needed for Java and C++.

Environment:
  LISTEN           "8080" (TCP port) or "unix:/path/to.sock" (default 8080)
  ACCESS_PASSWORD  optional; when set, the whole site asks for it (any username)
  MAX_JOBS         traces allowed to run at once (default 2, at most 4 in the container)
  RATE_LIMIT       Java/C++ runs allowed per visitor, as "runs/seconds" (default 30/600; 0 = off)
  TRUST_PROXY      "1" to read the visitor's address from X-Forwarded-For in port mode
                   (always used with a unix socket, where the reverse proxy is the only client)
"""
import base64
import hmac
import json
import os
import re
import shutil
import signal
import socketserver
import subprocess
import sys
import tempfile
import threading
import queue
import time
import uuid
from collections import deque
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PUBLIC = Path(os.environ.get('PUBLIC_DIR', ROOT.parent / 'public')).resolve()
JAVA_CLASSES = Path(os.environ.get('JAVA_CLASSES', ROOT / 'java' / 'classes'))
CPP_DIR = ROOT / 'cpp'
PRELUDE = Path(os.environ.get('CPP_PRELUDE', CPP_DIR / 'prelude.h'))
JOBS_DIR = Path(os.environ.get('JOBS_DIR', tempfile.gettempdir())) / 'codeviz-jobs'
PASSWORD = os.environ.get('ACCESS_PASSWORD', '')
MAX_JOBS = int(os.environ.get('MAX_JOBS', '2'))
MAX_CODE = 50_000
MAX_STDIN = 50_000
JOB_TIMEOUT = 25  # seconds; the tracers stop programs themselves after 10 s

# Each job may create at most this many processes/threads (counted per user, so a
# fork bomb stops here while the server keeps room under the container's pids limit).
JOB_NPROC = int(os.environ.get('JOB_NPROC', '300'))
active_sessions = set()
busy_uids = set()  # sandbox users lent to a run, from before it starts until it's cleaned up
sessions_lock = threading.Lock()
# Inside the container (the Dockerfile sets this) the server owns every process except
# tini, so it can sweep up processes that escaped their job. Never outside a container.
IN_CONTAINER = os.environ.get('CODEVIZ_CONTAINER') == '1'
# In the container the server runs as root (with only a few capabilities) and runs each
# program as its own unprivileged user, so programs can't signal or tamper with the server
# or with each other. Each concurrent run borrows one user from this pool; what the user
# leaves in /tmp is deleted before the next run gets it (clean_up_user).
SANDBOX_UIDS = [10001 + i for i in range(MAX_JOBS)]
SANDBOXED = IN_CONTAINER and os.geteuid() == 0
job_users = queue.Queue()
for _uid in SANDBOX_UIDS:
    job_users.put(_uid)


class RateLimiter:
    """Sliding window: at most `limit` runs per `window` seconds per visitor."""

    def __init__(self, spec):
        runs, _, seconds = (spec or '0').partition('/')
        self.limit = int(runs or 0)
        self.window = float(seconds or 600)
        self.hits = {}
        self.lock = threading.Lock()

    def check(self, key):
        """Returns 0 if allowed (and records the run), else seconds until the next run is allowed."""
        if self.limit <= 0:
            return 0
        now = time.monotonic()
        with self.lock:
            if len(self.hits) > 10_000:  # forget idle visitors
                self.hits = {k: q for k, q in self.hits.items() if q and q[-1] > now - self.window}
            q = self.hits.setdefault(key, deque())
            while q and q[0] <= now - self.window:
                q.popleft()
            if len(q) >= self.limit:
                return int(q[0] + self.window - now) + 1
            q.append(now)
            return 0


rate_limiter = RateLimiter(os.environ.get('RATE_LIMIT', '30/600'))
TRUST_PROXY = os.environ.get('TRUST_PROXY') == '1'

CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.py': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ttf': 'font/ttf',
    '.woff2': 'font/woff2',
    '.ico': 'image/x-icon',
}

CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'",  # Pyodide loads from jsDelivr
    "worker-src 'self'",
    "connect-src 'self' https://cdn.jsdelivr.net",
    # The editor (Monaco) injects its own styles; React escapes all content, so inline CSS is low risk.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",  # 'self': the editor's icon font
    "img-src 'self' data:",
    "frame-ancestors 'self'",
    "base-uri 'none'",
])


class TraceError(Exception):
    pass


def error_trace(message, line=None):
    return {'ok': False, 'steps': [], 'stdout': '', 'error': message, 'line': line, 'limit': False}


# ---------------------------------------------------------------------------
# running untrusted programs
# ---------------------------------------------------------------------------

def limited(cmd, timeout):
    """Caps file size, core dumps, CPU time and process count for the command and its children."""
    return ['prlimit', '--fsize=20971520', '--core=0', f'--cpu={timeout + 5}', f'--nproc={JOB_NPROC}', '--', *cmd]


def proc_session(pid):
    try:
        with open(f'/proc/{pid}/stat', 'rb') as fh:
            fields = fh.read().rsplit(b')', 1)[1].split()
        return int(fields[3])  # state, ppid, pgrp, session
    except (OSError, IndexError, ValueError):
        return None


def kill_where(should_kill):
    """Kills matching processes. Freezes them with SIGSTOP first and repeats, because a
    fork bomb refills every slot that a plain kill frees; stopped processes can't fork."""
    for _ in range(50):
        found = []
        for name in os.listdir('/proc'):
            if not name.isdigit():
                continue
            pid = int(name)
            if pid in (1, os.getpid()):
                continue  # init (tini) and the server itself
            try:
                if should_kill(pid):
                    os.kill(pid, signal.SIGSTOP)
                    found.append(pid)
            except (ProcessLookupError, PermissionError):
                pass
        if not found:
            return
        for pid in found:
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass


def proc_uid(pid):
    try:
        return os.stat(f'/proc/{pid}').st_uid
    except OSError:
        return None


def sandbox_owned(pid):
    return not SANDBOXED or proc_uid(pid) in SANDBOX_UIDS


def kill_job(sid, uid):
    """Kills everything a job started: its session (gdb runs programs in their own process
    group, but they stay in the session) and, in the container, everything its user owns,
    including processes that left the session with setsid()."""
    kill_where(lambda pid: proc_session(pid) == sid or (SANDBOXED and proc_uid(pid) == uid))


def hand_over(work, uid):
    """Gives the job folder to the job's sandbox user, readable by nobody else."""
    os.chmod(work, 0o700)
    if not SANDBOXED:
        return
    for root, dirs, files in os.walk(work):
        os.chown(root, uid, uid)
        for name in files:
            os.chown(os.path.join(root, name), uid, uid)


def clean_up_user(uid):
    """Container only: delete what a finished run's user left behind in the shared /tmp and
    /dev/shm, and its System V IPC objects, so one run can't fill the disk or leave files for
    later runs. Its processes are already gone (kill_job)."""
    if not SANDBOXED:
        return
    for shared in (Path(tempfile.gettempdir()), Path('/dev/shm')):
        try:
            entries = list(os.scandir(shared))
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.stat(follow_symlinks=False).st_uid != uid:
                    continue
                if entry.is_dir(follow_symlinks=False):
                    shutil.rmtree(entry.path)  # doesn't follow symlinks
                else:
                    os.unlink(entry.path)
            except OSError as e:
                sys.stderr.write(f'cleanup {entry.path}: {e!r}\n')
    try:  # run as the user, since only an object's owner (or CAP_IPC_OWNER) can remove it
        subprocess.run(['ipcrm', '--all'], user=uid, group=uid, extra_groups=[], env=base_env(),
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    except (OSError, subprocess.SubprocessError) as e:
        sys.stderr.write(f'ipcrm: {e!r}\n')


def is_healthcheck(pid):
    try:
        with open(f'/proc/{pid}/cmdline', 'rb') as fh:
            return fh.read().split(b'\0')[:5] == [b'python3', b'-I', b'-B', b'/app/server/server.py', b'--health']
    except OSError:
        return False


def reap_strays():
    """Container only: kill anything that isn't the server, a running job, or a healthcheck
    (e.g. a process that called setsid() to escape its job)."""
    def stray(pid):
        if not sandbox_owned(pid) or is_healthcheck(pid):
            return False
        with sessions_lock:  # read fresh each time: runs start while kill_where loops
            return proc_session(pid) not in active_sessions and proc_uid(pid) not in busy_uids
    kill_where(stray)


def reaper_loop():
    while True:
        threading.Event().wait(5)
        try:
            reap_strays()
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f'reaper: {e!r}\n')


def run_limited(cmd, cwd, timeout, env, uid):
    # New session = new process group, so the whole tree can be killed at once.
    drop = {'user': uid, 'group': uid, 'extra_groups': []} if SANDBOXED else {}
    proc = subprocess.Popen(limited(cmd, timeout), cwd=cwd, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, start_new_session=True, **drop)
    with sessions_lock:
        active_sessions.add(proc.pid)  # start_new_session makes the child a session leader
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.communicate()
        raise TraceError(f'The run took longer than {timeout} seconds and was stopped.')
    finally:
        kill_job(proc.pid, uid)  # the traced JVM, gdb's program, anything they forked
        with sessions_lock:
            active_sessions.discard(proc.pid)
    return proc.returncode, out, err


def base_env():
    return {
        'PATH': os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'),
        'HOME': '/tmp',
        'LANG': 'C.UTF-8',
        'JAVA_HOME': os.environ.get('JAVA_HOME', ''),
    }


def trace_java(work, code, stdin, uid):
    (work / 'source.txt').write_text(code, encoding='utf-8')
    (work / 'stdin.txt').write_text(stdin, encoding='utf-8')
    hand_over(work, uid)
    cmd = ['java', '-XX:+UseSerialGC', '-XX:-UsePerfData', '-XX:+DisableAttachMechanism', '-Xmx256m', '-XX:TieredStopAtLevel=1', '-cp', str(JAVA_CLASSES), 'Tracer', str(work)]
    _, out, err = run_limited(cmd, work, JOB_TIMEOUT, base_env(), uid)
    try:
        return json.loads(out.decode('utf-8'))
    except ValueError:
        raise TraceError('The Java tracer failed: ' + err.decode('utf-8', 'replace').strip()[-300:])


def trace_cpp(work, code, stdin, uid):
    (work / 'main.cpp').write_text(code, encoding='utf-8')
    (work / 'stdin.txt').write_text(stdin, encoding='utf-8')
    hand_over(work, uid)
    includes = ['-include', str(PRELUDE)]
    helpers = []
    if not re.search(r'\b(struct|class)\s+ListNode\b', code):
        includes += ['-include', str(CPP_DIR / 'listnode.h')]
        helpers.append('ListNode')
    if not re.search(r'\b(struct|class)\s+TreeNode\b', code):
        includes += ['-include', str(CPP_DIR / 'treenode.h')]
        helpers.append('TreeNode')
    compile_cmd = ['g++', '-std=gnu++20', '-g', '-O0', '-fno-omit-frame-pointer', *includes, '-o', 'prog', 'main.cpp']
    code_rc, _, err = run_limited(compile_cmd, work, 30, base_env(), uid)
    if code_rc != 0:
        text = err.decode('utf-8', 'replace')
        m = re.search(r'main\.cpp:(\d+):\d+: (?:fatal )?error: (.+)', text)
        if m:
            message = m.group(2).strip().replace('‘', "'").replace('’', "'")
            return error_trace(f'Compile error: {message}', int(m.group(1)))
        return error_trace('Compile error: ' + (text.strip().splitlines() or ['unknown'])[-1][:300])
    env = base_env()
    env.update(CV_WORK=str(work), CV_HELPERS=' '.join(helpers))
    run_limited(['gdb', '-q', '-nx', '-batch', '-x', str(CPP_DIR / 'tracer_gdb.py')], work, JOB_TIMEOUT, env, uid)
    try:
        return json.loads((work / 'trace.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise TraceError('The program stopped before it could be traced. This happens when a program kills other processes or crashes the debugger.')


def trace(language, code, stdin):
    try:
        uid = job_users.get(timeout=20)  # also limits how many programs run at once
    except queue.Empty:
        raise TraceError('The server is busy running other programs. Try again in a few seconds.')
    try:
        with sessions_lock:
            busy_uids.add(uid)
        work = JOBS_DIR / uuid.uuid4().hex
        try:
            work.mkdir()
            if language == 'java':
                return trace_java(work, code, stdin, uid)
            return trace_cpp(work, code, stdin, uid)
        finally:
            shutil.rmtree(work, ignore_errors=True)
            kill_job(-1, uid)  # anything of this user's still alive (run_limited already did this)
            clean_up_user(uid)
    finally:
        with sessions_lock:
            busy_uids.discard(uid)
        job_users.put(uid)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = 'CodeVisualizer'
    sys_version = ''

    def visitor(self):
        """The visitor's address. Behind the reverse proxy it's the last X-Forwarded-For entry,
        the one the proxy itself added."""
        via_socket = not self.client_address or not self.client_address[0]
        forwarded = self.headers.get('X-Forwarded-For', '')
        if (via_socket or TRUST_PROXY) and forwarded:
            return forwarded.split(',')[-1].strip()
        return self.client_address[0] if not via_socket else 'local'

    def address_string(self):
        return self.visitor()

    def log_message(self, fmt, *args):
        sys.stderr.write(f'{self.command} {self.path} {fmt % args}\n')

    def authorized(self):
        if not PASSWORD:
            return True
        header = self.headers.get('Authorization', '')
        if not header.startswith('Basic '):
            return False
        try:
            supplied = base64.b64decode(header[6:]).decode('utf-8').split(':', 1)[-1]
        except ValueError:
            return False
        return hmac.compare_digest(supplied.encode(), PASSWORD.encode())

    def send(self, status, body, content_type='application/json; charset=utf-8', extra=None):
        data = body if isinstance(body, bytes) else json.dumps(body).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', CSP)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def guard(self):
        if self.authorized():
            return True
        self.send(HTTPStatus.UNAUTHORIZED, b'Authentication required', 'text/plain; charset=utf-8',
                  {'WWW-Authenticate': 'Basic realm="Code Visualizer", charset="UTF-8"'})
        return False

    def do_GET(self):
        if not self.guard():
            return
        path = self.path.split('?', 1)[0].split('#', 1)[0]
        if path == '/api/health':
            return self.send(HTTPStatus.OK, {'ok': True, 'languages': ['python', 'java', 'cpp']})
        rel = 'index.html' if path == '/' else path.lstrip('/')
        target = (PUBLIC / rel).resolve()
        if not str(target).startswith(str(PUBLIC) + os.sep) or not target.is_file():
            return self.send(HTTPStatus.NOT_FOUND, b'Not found', 'text/plain; charset=utf-8')
        self.send(HTTPStatus.OK, target.read_bytes(), CONTENT_TYPES.get(target.suffix, 'application/octet-stream'),
                  {'Cache-Control': 'no-cache'})

    do_HEAD = do_GET

    def do_POST(self):
        if not self.guard():
            return
        if self.path != '/api/trace':
            return self.send(HTTPStatus.NOT_FOUND, {'error': 'Not found'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_CODE + MAX_STDIN + 10_000:
            return self.send(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, error_trace('The program is too large (50 KB max).'))
        try:
            body = json.loads(self.rfile.read(length).decode('utf-8'))
            language = body.get('language')
            code = str(body.get('code', ''))
            stdin = str(body.get('stdin', ''))
        except (ValueError, AttributeError):
            return self.send(HTTPStatus.BAD_REQUEST, error_trace('Invalid request.'))
        if language not in ('java', 'cpp'):
            return self.send(HTTPStatus.BAD_REQUEST, error_trace('Language must be java or cpp.'))
        if len(code) > MAX_CODE or len(stdin) > MAX_STDIN:
            return self.send(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, error_trace('The program or input is too large (50 KB max).'))
        wait = rate_limiter.check(self.visitor())
        if wait:
            minutes = f'{wait // 60} min ' if wait >= 60 else ''
            return self.send(HTTPStatus.TOO_MANY_REQUESTS, error_trace(
                f'You have run a lot of Java/C++ programs in a short time. Try again in {minutes}{wait % 60} s. '
                'Python runs in your browser and is not limited.'), extra={'Retry-After': str(wait)})
        try:
            result = trace(language, code, stdin)
        except TraceError as e:
            result = error_trace(str(e))
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f'trace failed: {e!r}\n')
            result = error_trace('The server hit an error while running the program.')
        self.send(HTTPStatus.OK, result)


class UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def get_request(self):
        request, _ = super().get_request()
        return request, ('', 0)


def main():
    if SANDBOXED and MAX_JOBS > 4:
        sys.exit('MAX_JOBS can be at most 4: the image has four sandbox users (10001-10004).')
    listen = os.environ.get('LISTEN', '8080')
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(JOBS_DIR, 0o711)  # runs can enter their own folder but not list the others
    if listen.startswith('unix:'):
        path = listen[5:]
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        server = UnixHTTPServer(path, Handler)
        os.chmod(path, 0o666)  # the reverse proxy runs as a different user
        where = path
    else:
        server = ThreadingHTTPServer(('0.0.0.0', int(listen)), Handler)
        server.daemon_threads = True
        where = f'http://localhost:{listen}'
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown).start())
    if IN_CONTAINER:
        threading.Thread(target=reaper_loop, daemon=True).start()
    print(f'Code Visualizer listening on {where}', flush=True)
    if not PASSWORD:
        print('Note: ACCESS_PASSWORD is not set, so anyone who can reach this server can run code on it.', flush=True)
    server.serve_forever()


def health():
    """Docker healthcheck: exit 0 if the server answers (401 counts when a password is set)."""
    import http.client
    import socket
    listen = os.environ.get('LISTEN', '8080')
    try:
        if listen.startswith('unix:'):
            conn = http.client.HTTPConnection('localhost', timeout=5)
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.settimeout(5)
            sock.connect(listen[5:])
            conn.sock = sock
        else:
            conn = http.client.HTTPConnection('127.0.0.1', int(listen), timeout=5)
        conn.request('GET', '/api/health')
        return 0 if conn.getresponse().status < 500 else 1
    except OSError:
        return 1


if __name__ == '__main__':
    if '--health' in sys.argv:
        sys.exit(health())
    main()
