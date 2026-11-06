"""Checks a running Code Visualizer: Java and C++ traces work and the sandbox holds.

Usage (Python 3.8+, no packages needed):
    python3 tests/smoke_test.py --socket socket/codeviz.sock    # the Caddy setup
    python3 tests/smoke_test.py --url http://localhost:8080     # compose.local.yml

It sends about 12 runs, which counts toward your own rate limit (30 per 10 minutes by default).
"""
import argparse
import http.client
import json
import socket
import sys
import threading
import time

PROGRAMS = {
    'java_hello': ('java', '''public class Main {
    public static void main(String[] args) {
        int x = 6;
        System.out.println(x * 7);
    }
}
'''),
    'cpp_hello': ('cpp', '''int main() {
    vector<int> v = {6, 7};
    cout << v[0] * v[1];
}
'''),
    'java_compile_error': ('java', '''public class Main {
    public static void main(String[] args) {
        int x = 5
    }
}
'''),
    'cpp_infinite_loop': ('cpp', '''int main() {
    int x = 0;
    while (true) {
        x++;
    }
}
'''),
    'cpp_network': ('cpp', '''#include <netdb.h>
int main() {
    cout << (gethostbyname("example.com") ? "NETWORK OPEN" : "blocked");
}
'''),
    'cpp_write_app': ('cpp', '''int main() {
    cout << (access("/app/server/server.py", W_OK) == 0 ? "APP WRITABLE" : "read-only");
}
'''),
    'cpp_fork_bomb': ('cpp', '''#include <unistd.h>
int main() {
    while (true) {
        fork();
    }
}
'''),
    'cpp_slow': ('cpp', '''#include <unistd.h>
int main() {
    for (int i = 0; i < 20; i++) {
        usleep(100000);
    }
    cout << "survived";
}
'''),
    'cpp_kill_everything': ('cpp', '''#include <signal.h>
int main() {
    kill(-1, SIGKILL);
}
'''),
}


class Client:
    def __init__(self, url=None, sock=None):
        self.url, self.sock = url, sock

    def request(self, method, path, body=None):
        if self.sock:
            conn = http.client.HTTPConnection('localhost', timeout=90)
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(90)
            s.connect(self.sock)
            conn.sock = s
        else:
            host = self.url.split('://', 1)[-1].rstrip('/')
            conn = http.client.HTTPConnection(host, timeout=90)
        conn.request(method, path, json.dumps(body) if body else None, {'Content-Type': 'application/json'})
        res = conn.getresponse()
        return res.status, json.loads(res.read() or b'{}')

    def trace(self, name):
        lang, code = PROGRAMS[name]
        try:
            return self.request('POST', '/api/trace', {'language': lang, 'code': code, 'stdin': ''})[1]
        except (OSError, http.client.HTTPException, ValueError) as e:
            # A dropped connection means the server crashed: report it as a failed check.
            return {'ok': False, 'steps': [], 'stdout': '', 'error': f'no response: {e!r}', 'line': None, 'limit': False}

    def health(self):
        try:
            return self.request('GET', '/api/health')
        except (OSError, http.client.HTTPException, ValueError) as e:
            return 0, {'error': repr(e)}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    where = parser.add_mutually_exclusive_group(required=True)
    where.add_argument('--url', help='e.g. http://localhost:8080')
    where.add_argument('--socket', help='e.g. socket/codeviz.sock')
    args = parser.parse_args()
    client = Client(args.url, args.socket)
    failures = []

    def check(label, ok, detail=''):
        print(f"{'PASS' if ok else 'FAIL'}  {label}{f'  ({detail})' if detail and not ok else ''}")
        if not ok:
            failures.append(label)
        sys.stdout.flush()

    status, health = client.health()
    check('server is up', status == 200 and health.get('ok'), f'{status} {health}')

    r = client.trace('java_hello')
    check('Java runs and is traced', r['ok'] and r['stdout'].strip() == '42' and len(r['steps']) > 2, r.get('error'))
    r = client.trace('cpp_hello')
    check('C++ runs and is traced', r['ok'] and r['stdout'].strip() == '42' and len(r['steps']) > 2, r.get('error'))
    r = client.trace('java_compile_error')
    check('compile errors point at their line', not r['ok'] and r['line'] == 3, r)
    r = client.trace('cpp_infinite_loop')
    check('infinite loops are stopped', r['limit'], r.get('error'))
    r = client.trace('cpp_network')
    check('programs have no network', r['stdout'] == 'blocked', r['stdout'] or r.get('error'))
    r = client.trace('cpp_write_app')
    check('programs cannot change the app', r['stdout'] == 'read-only', r['stdout'] or r.get('error'))
    client.trace('cpp_fork_bomb')
    r = client.trace('cpp_hello')
    check('a fork bomb leaves the server working', r['ok'] and r['stdout'].strip() == '42', r.get('error'))

    # One visitor's program must not be able to kill another's that runs at the same time.
    slow = {}
    t = threading.Thread(target=lambda: slow.update(client.trace('cpp_slow')))
    t.start()
    time.sleep(1.0)
    client.trace('cpp_kill_everything')
    t.join()
    check("a program can't kill other visitors' programs", slow.get('stdout') == 'survived', slow.get('error'))
    status, health = client.health()
    check("a program can't kill the server", status == 200, status)

    print(f"\n{'All checks passed.' if not failures else f'{len(failures)} check(s) failed.'}")
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
