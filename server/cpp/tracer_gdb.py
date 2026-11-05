"""GDB script that traces a C++ program line by line and writes the trace as JSON.

Run as:  CV_WORK=<dir> gdb -q -nx -batch -x tracer_gdb.py
<dir> holds the compiled `prog`, `stdin.txt`; this script writes `trace.json` there.
The JSON format matches the Python and Java tracers.
"""
import itertools
import json
import os
import re
import signal
import sys
import threading
import time

import gdb

WORK = os.environ['CV_WORK']
PROG = os.path.join(WORK, 'prog')
USER_FILE = 'main.cpp'
HELPER_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_FILE = os.path.join(WORK, 'stdout.txt')
ERR_FILE = os.path.join(WORK, 'stderr.txt')
MAX_STEPS = int(os.environ.get('CV_MAX_STEPS', '3000'))
MAX_ITEMS = 80
MAX_OBJECTS = 300
MAX_OUTPUT = 100_000
TIME_BUDGET = float(os.environ.get('CV_TIME_BUDGET', '10'))

# libstdc++ pretty printers make vector/map/string readable.
try:
    for path in ('/usr/share/gcc/python',) + tuple(
            p for p in (os.path.join('/usr/share', d, 'python') for d in os.listdir('/usr/share') if d.startswith('gcc-'))):
        if os.path.isdir(path) and path not in sys.path:
            sys.path.insert(0, path)
    from libstdcxx.v6.printers import register_libstdcxx_printers
    register_libstdcxx_printers(None)
except Exception:  # noqa: BLE001 - printers are a nice-to-have
    pass

result = {'ok': True, 'steps': [], 'stdout': '', 'error': None, 'line': None, 'limit': False}
steps = result['steps']


# ---------------------------------------------------------------------------
# value encoding
# ---------------------------------------------------------------------------

def short_type(name):
    name = (name or '').replace('std::__cxx11::', '').replace('std::', '')
    return name.split('<', 1)[0].strip() or name


def is_string_type(name):
    return bool(re.match(r'^(std::)?(__cxx11::)?basic_string<char\b', name or '')) or name in ('std::string', 'string')


def prim(kind, r, **extra):
    d = {'k': kind, 'r': r}
    d.update(extra)
    return d


def char_prim(n):
    ch = chr(n & 0xFF) if n >= 0 else chr(n & 0xFF)
    if not ch.isprintable():
        return prim('int', str(n), n=n)
    return prim('str', "'" + ch + "'", s=ch)


class Encoder:
    def __init__(self):
        self.ids = {}
        self.synthetic = itertools.count(1)

    def oid(self, key):
        n = self.ids.get(key)
        if n is None:
            n = self.ids[key] = len(self.ids) + 1
        return n

    def ref(self, key, value, heap, pending):
        n = self.oid(key)
        k = str(n)
        if k not in heap and len(heap) < MAX_OBJECTS:
            heap[k] = None
            pending.append((n, value))
        return {'k': 'ref', 'id': n}

    def value(self, v, heap, pending):
        # Plain Python values come from some pretty printers.
        if isinstance(v, bool):
            return prim('bool', 'true' if v else 'false')
        if isinstance(v, int):
            return prim('int', str(v), n=v) if abs(v) < 2 ** 53 else prim('int', str(v))
        if isinstance(v, float):
            return prim('float', repr(v))
        if isinstance(v, str):
            return prim('str', json.dumps(v), s=v) if len(v) <= MAX_ITEMS else prim('str', json.dumps(v[:119] + '…'))
        try:
            t = v.type.strip_typedefs()
            if t.code in (gdb.TYPE_CODE_REF, gdb.TYPE_CODE_RVALUE_REF):
                v = v.referenced_value()
                t = v.type.strip_typedefs()
            code = t.code
            if code == gdb.TYPE_CODE_BOOL:
                return prim('bool', 'true' if bool(v) else 'false')
            if code == gdb.TYPE_CODE_CHAR or (code == gdb.TYPE_CODE_INT and t.name in ('char', 'signed char', 'unsigned char')):
                return char_prim(int(v))
            if code == gdb.TYPE_CODE_INT:
                n = int(v)
                return prim('int', str(n), n=n) if abs(n) < 2 ** 53 else prim('int', str(n))
            if code == gdb.TYPE_CODE_FLT:
                return prim('float', repr(float(v)))
            if code == gdb.TYPE_CODE_ENUM:
                return prim('other', str(v))
            if code == gdb.TYPE_CODE_PTR:
                addr = int(v)
                if addr == 0:
                    return prim('none', 'nullptr')
                target = t.target().strip_typedefs()
                if target.code == gdb.TYPE_CODE_CHAR or target.name in ('char', 'const char'):
                    try:
                        s = v.string(length=MAX_ITEMS, errors='replace')
                        return prim('str', json.dumps(s), s=s)
                    except (gdb.error, UnicodeDecodeError):
                        return prim('other', hex(addr))
                if target.code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION):
                    obj = v.dereference()
                    obj.fetch_lazy()  # raises gdb.MemoryError for dangling pointers
                    return self.ref(f'{addr}:{target.name or target.tag}', obj, heap, pending)
                return prim('other', hex(addr))
            if code == gdb.TYPE_CODE_ARRAY:
                return self.ref(self.key_for(v, t), v, heap, pending)
            if code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION):
                name = t.name or t.tag or ''
                if is_string_type(name):
                    s = self.string_value(v)
                    if s is not None:
                        out = prim('str', json.dumps(s if len(s) <= 120 else s[:119] + '…'))
                        if len(s) <= MAX_ITEMS:
                            out['s'] = s
                        return out
                return self.ref(self.key_for(v, t), v, heap, pending)
            return prim('other', str(v))
        except gdb.MemoryError:
            return prim('other', '<invalid memory>')
        except Exception as e:  # noqa: BLE001 - garbage/uninitialized values must not stop the trace
            return prim('other', f'<{type(e).__name__}>')

    def key_for(self, v, t):
        addr = v.address
        if addr is not None:
            return f'{int(addr)}:{t.name or t.tag or t.code}'
        return f'synthetic:{next(self.synthetic)}'

    @staticmethod
    def string_value(v):
        try:
            length = int(v['_M_string_length'])
            if 0 <= length <= 1_000_000:
                return v['_M_dataplus']['_M_p'].string(length=min(length, 2000), errors='replace')
        except (gdb.error, UnicodeDecodeError):
            pass
        try:
            s = str(v)
            return json.loads(s) if s.startswith('"') else s
        except Exception:  # noqa: BLE001
            return None

    def encode_object(self, v, heap, pending):
        t = v.type.strip_typedefs()
        name = t.name or t.tag or ''
        enc = lambda x: self.value(x, heap, pending)  # noqa: E731

        if t.code == gdb.TYPE_CODE_ARRAY:
            lo, hi = t.range()
            n = hi - lo + 1
            items = [enc(v[i]) for i in range(lo, lo + min(n, MAX_ITEMS))]
            return {'t': 'list', 'cls': f'{short_type(t.target().name or "")}[{n}]', 'len': n, 'items': items}

        if name.startswith('std::pair<'):
            return {'t': 'tuple', 'cls': 'pair', 'len': 2, 'items': [enc(v['first']), enc(v['second'])]}

        vis = gdb.default_visualizer(v)
        if vis is not None and hasattr(vis, 'children'):
            hint = vis.display_hint() if hasattr(vis, 'display_hint') else None
            cls = short_type(name)
            try:
                summary = str(vis.to_string()) if hasattr(vis, 'to_string') else ''
            except Exception:  # noqa: BLE001
                summary = ''
            m = re.search(r'(?:length|with) (\d+)', summary)
            if hint == 'map':
                kids = list(itertools.islice(vis.children(), 2 * MAX_ITEMS))
                entries = [[enc(kids[i][1]), enc(kids[i + 1][1])] for i in range(0, len(kids) - 1, 2)]
                length = int(m.group(1)) if m else len(entries)
                return {'t': 'dict', 'cls': cls, 'len': length, 'entries': entries}
            kids = list(itertools.islice(vis.children(), MAX_ITEMS))
            items = [enc(c[1]) for c in kids]
            length = int(m.group(1)) if m else len(items)
            if 'tuple' in cls:
                kind = 'tuple'
            elif 'set' in cls:
                kind = 'set'
            elif cls in ('deque', 'queue', 'stack', 'list', 'forward_list'):
                kind = 'deque'
            else:
                kind = 'list'
            return {'t': kind, 'cls': cls, 'len': length, 'items': items}

        attrs = []

        def add_fields(val, typ):
            for f in typ.fields():
                if len(attrs) >= MAX_ITEMS:
                    return
                if f.is_base_class:
                    add_fields(val.cast(f.type), f.type.strip_typedefs())
                    continue
                if f.artificial or not hasattr(f, 'bitpos') or not f.name:
                    continue  # vptr, static members, anonymous
                attrs.append([f.name, enc(val[f])])

        add_fields(v, t)
        return {'t': 'obj', 'cls': short_type(name) or 'struct', 'attrs': attrs}

    def drain(self, heap, pending):
        while pending:
            n, v = pending.pop()
            try:
                heap[str(n)] = self.encode_object(v, heap, pending)
            except gdb.MemoryError:
                # Usually a variable whose multi-line declaration hasn't finished running.
                heap[str(n)] = {'t': 'other', 'cls': 'value', 'r': '(not initialized yet)'}
            except Exception as e:  # noqa: BLE001
                heap[str(n)] = {'t': 'other', 'cls': 'value', 'r': f'<{type(e).__name__}>'}


enc = Encoder()


# ---------------------------------------------------------------------------
# frames
# ---------------------------------------------------------------------------

def is_user(frame):
    try:
        sal = frame.find_sal()
        return sal.symtab is not None and os.path.basename(sal.symtab.filename) == USER_FILE
    except gdb.error:
        return False


def user_frames():
    frames = []
    f = gdb.newest_frame()
    while f is not None:
        if is_user(f):
            frames.append(f)
        f = f.older()
    frames.reverse()
    return frames


def frame_label(frame):
    name = frame.name() or '?'
    if 'lambda' in name:
        return 'lambda'
    name = re.sub(r'\(.*\)$', '', name)
    return name.split('::')[-1]


visited = {}  # frame depth -> (function name, set of lines already executed)


def frame_vars(frame, depth, line):
    """Locals in scope, hiding ones whose declaration hasn't run yet (they hold garbage)."""
    fname, seen_lines = visited.get(depth, (None, set()))
    blocks = []
    try:
        block = frame.block()
    except RuntimeError:
        return []
    while block is not None:
        blocks.append(block)
        if block.function is not None:
            break
        block = block.superblock
    out = []
    names = set()
    for block in blocks:  # innermost first; inner declarations shadow outer ones
        for sym in block:
            if not (sym.is_variable or sym.is_argument) or sym.name in names:
                continue
            if sym.name.startswith('__'):
                continue  # compiler-made locals such as range-for's __for_begin
            # Visible once execution has moved past the declaration in this frame
            # (on a loop's second pass, lines after the header have run).
            if not sym.is_argument and not (sym.line < line or any(l > sym.line for l in seen_lines)):
                continue
            try:
                val = sym.value(frame)
            except Exception:  # noqa: BLE001
                continue
            if sym.name == 'this':
                try:
                    target = val.type.strip_typedefs().target().strip_typedefs()
                    if not any(not f.is_base_class and hasattr(f, 'bitpos') for f in target.fields()):
                        continue
                except Exception:  # noqa: BLE001
                    continue
            names.add(sym.name)
            out.append((sym.name, val, sym.line))
    out.sort(key=lambda x: (x[0] != 'this', x[2]))
    return out


def snapshot(event, line, ret=None, exc=None, stack_frames=None):
    heap, pending = {}, []
    stack = []
    frames = stack_frames if stack_frames is not None else user_frames()
    for depth, f in enumerate(frames):
        sal = f.find_sal()
        fline = sal.line
        try:
            found = frame_vars(f, depth, fline)
        except Exception:  # noqa: BLE001
            found = []
        vars_ = [[name, enc.value(val, heap, pending)] for name, val, _ in found]
        stack.append({'name': frame_label(f), 'line': fline, 'vars': vars_})
    step = {'line': line, 'event': event, 'stack': stack, 'out': output_size()}
    if ret is not None:
        step['ret'] = enc.value(ret, heap, pending)
    if exc:
        step['exc'] = exc
    enc.drain(heap, pending)
    step['heap'] = heap
    return step


def output_size():
    try:
        return min(os.path.getsize(OUT_FILE), MAX_OUTPUT)
    except OSError:
        return 0


# ---------------------------------------------------------------------------
# return values (FinishBreakpoint fires as a frame returns)
# ---------------------------------------------------------------------------

returned = []


class ReturnCatcher(gdb.FinishBreakpoint):
    def stop(self):
        try:
            rv = self.return_value
        except Exception:  # noqa: BLE001
            rv = None
        returned.append(rv)
        return False

    def out_of_scope(self):
        pass


last_signal = []
timed_out = threading.Event()
finished = threading.Event()


def watchdog(pid, deadline):
    """`step` waits until the line changes, so a tight one-line loop never returns.
    Interrupt the program when time runs out so the trace can still be returned."""
    while not finished.wait(0.2):
        if time.monotonic() > deadline:
            timed_out.set()
            try:
                os.kill(pid, signal.SIGINT)
            except OSError:
                return


def on_stop(event):
    if isinstance(event, gdb.SignalEvent):
        last_signal.append(event.stop_signal)


SIGNAL_TEXT = {
    'SIGSEGV': 'Segmentation fault: the program read or wrote memory it does not own (null or dangling pointer, or an index out of range)',
    'SIGABRT': 'The program aborted (an uncaught exception or a failed assert)',
    'SIGFPE': 'Arithmetic error (for example, division by zero)',
    'SIGBUS': 'Bus error: invalid memory access',
    'SIGXFSZ': 'The program wrote more than the 20 MB file size limit',
    'SIGXCPU': 'The program used up its CPU time limit',
}


def alive():
    try:
        return gdb.selected_inferior().pid != 0
    except gdb.error:
        return False


# ---------------------------------------------------------------------------
# main loop
# ---------------------------------------------------------------------------

def finish_error(message, line):
    result['ok'] = False
    result['error'] = message
    result['line'] = line


def run():
    for cmd in ('set pagination off', 'set confirm off', 'set width 0', 'set print pretty off',
                'set debuginfod enabled off', 'set print elements 200', 'set startup-with-shell on',
                # Docker's default seccomp profile blocks turning off ASLR; don't try.
                'set disable-randomization off'):
        try:
            gdb.execute(cmd, to_string=True)
        except gdb.error:
            pass
    # Never step into the standard library or the helper headers. (File-based skips make
    # GDB step over the user's own calls on the same line, so skip by function name.)
    patterns = [r'^std::', r'^__gnu_cxx::', r'^__cxx', r'^cv_internal::', r'^buildList$', r'^buildTree$']
    helpers = os.environ.get('CV_HELPERS', '').split()
    patterns += [rf'^{h}::{h}$' for h in helpers]
    for pattern in patterns:
        try:
            gdb.execute(f'skip -rfu {pattern}', to_string=True)
        except gdb.error:
            pass
    gdb.events.stop.connect(on_stop)
    gdb.execute(f'file {PROG}', to_string=True)
    gdb.execute('break main', to_string=True)
    stdin_path = os.path.join(WORK, 'stdin.txt')
    gdb.execute(f'run < {stdin_path} > {OUT_FILE} 2> {ERR_FILE}', to_string=True)

    deadline = time.monotonic() + TIME_BUDGET
    threading.Thread(target=watchdog, args=(gdb.selected_inferior().pid, deadline), daemon=True).start()
    prev_depth = 0
    prev_func = {}
    while alive():
        if timed_out.is_set() or time.monotonic() > deadline:
            result['limit'] = True
            result['error'] = f'Stopped after {TIME_BUDGET:g} seconds. Is there an infinite loop? Showing the steps recorded so far.'
            gdb.execute('kill', to_string=True)
            return
        if last_signal:
            sig = last_signal[-1]
            frames = user_frames()
            line = frames[-1].find_sal().line if frames else None
            stderr_text = read_text(ERR_FILE).strip()
            message = SIGNAL_TEXT.get(sig, f'Program stopped by signal {sig}')
            if stderr_text and sig == 'SIGABRT':
                message = stderr_text.splitlines()[0][:300]
                if 'what():' in stderr_text:
                    message += ' ' + stderr_text.split('what():', 1)[1].strip().splitlines()[0][:200]
            finish_error(message, line)
            steps.append(snapshot('error', line, exc=message, stack_frames=frames))
            gdb.execute('kill', to_string=True)
            return
        if len(steps) >= MAX_STEPS:
            result['limit'] = True
            result['error'] = f'Stopped after {MAX_STEPS} steps. Is there an infinite loop? Showing the first {MAX_STEPS} steps.'
            gdb.execute('kill', to_string=True)
            return

        frame = gdb.selected_frame()
        if not is_user(frame):
            gdb.execute('finish', to_string=True)
            continue

        frames = user_frames()
        depth = len(frames)
        line = frame.find_sal().line

        # A function returned since the last step: replay its last state with the return value.
        if depth < prev_depth and steps:
            last = steps[-1]
            rv = returned.pop() if returned else None
            ret_step = dict(last)
            ret_step['event'] = 'return'
            ret_step['out'] = output_size()
            if rv is not None:
                heap = dict(last['heap'])
                pending = []
                ret_step['ret'] = enc.value(rv, heap, pending)
                enc.drain(heap, pending)
                ret_step['heap'] = heap
            steps.append(ret_step)
            for d in list(visited):
                if d >= depth:
                    del visited[d]

        # Entered a new function: watch for its return value and reset which lines have run.
        fname = frame.name()
        if depth > prev_depth or prev_func.get(depth - 1) != fname:
            visited[depth - 1] = (fname, set())
            if depth > 1:
                try:
                    ReturnCatcher(frame, internal=True)
                except (ValueError, gdb.error):
                    pass
        prev_func[depth - 1] = fname

        steps.append(snapshot('line', line, stack_frames=frames))
        visited.setdefault(depth - 1, (fname, set()))[1].add(line)
        prev_depth = depth

        try:
            gdb.execute('step', to_string=True)
        except gdb.error:
            break


def read_text(path, limit=MAX_OUTPUT):
    try:
        with open(path, encoding='utf-8', errors='replace') as fh:
            return fh.read(limit + 1)
    except OSError:
        return ''


try:
    run()
except Exception as e:  # noqa: BLE001
    if result['ok'] and not result['limit']:
        finish_error(f'Tracer error: {e}', None)
finally:
    finished.set()

out = read_text(OUT_FILE)
result['stdout'] = out[:MAX_OUTPUT] + ('\n[output truncated]' if len(out) > MAX_OUTPUT else '')
if result['ok'] and not result['limit'] and steps:
    final = dict(steps[-1])
    final['event'] = 'done'
    final['out'] = output_size()
    final.pop('ret', None)
    steps.append(final)
    try:
        code = int(gdb.parse_and_eval('$_exitcode'))
        if code != 0:
            err = read_text(ERR_FILE).strip()
            finish_error(f'Program exited with code {code}' + (f': {err.splitlines()[0][:200]}' if err else ''), None)
            final['event'] = 'error'
    except (gdb.error, TypeError, ValueError):
        pass

with open(os.path.join(WORK, 'trace.json'), 'w', encoding='utf-8') as fh:
    json.dump(result, fh)
