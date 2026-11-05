"""Execution tracer for the code visualizer.

Runs user code under sys.settrace and records a snapshot of the call stack and
every reachable object at each step. Runs in Pyodide (in a Web Worker) but is
plain CPython, so it can be tested locally with `python3`.
"""
import bisect
import builtins
import collections
import functools
import heapq
import inspect
import io
import itertools
import json
import math
import string
import sys
import types
import typing

USER_FILE = '<user>'
MAX_STEPS = 3000
MAX_ITEMS = 80        # items shown per container
MAX_OBJECTS = 300     # objects captured per step
MAX_REPR = 120
MAX_OUTPUT = 100_000


class StepLimit(BaseException):
    """Raised from the tracer to stop runaway programs (not catchable by `except Exception`)."""


# ---------- LeetCode-style helpers available to user code ----------

class ListNode:
    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next

    def __repr__(self):
        return f'ListNode({self.val!r})'


class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val = val
        self.left = left
        self.right = right

    def __repr__(self):
        return f'TreeNode({self.val!r})'


def build_list(values):
    """build_list([1, 2, 3]) -> 1 -> 2 -> 3"""
    dummy = ListNode()
    cur = dummy
    for v in values:
        cur.next = ListNode(v)
        cur = cur.next
    return dummy.next


def build_tree(values):
    """build_tree([3, 9, 20, None, None, 15, 7]) using LeetCode's level-order format."""
    if not values or values[0] is None:
        return None
    it = iter(values)
    root = TreeNode(next(it))
    queue = collections.deque([root])
    while queue:
        node = queue.popleft()
        for side in ('left', 'right'):
            try:
                v = next(it)
            except StopIteration:
                return root
            if v is not None:
                child = TreeNode(v)
                setattr(node, side, child)
                queue.append(child)
    return root


PRELOAD = {
    'ListNode': ListNode, 'TreeNode': TreeNode,
    'build_list': build_list, 'build_tree': build_tree,
    'List': typing.List, 'Optional': typing.Optional, 'Dict': typing.Dict,
    'Set': typing.Set, 'Tuple': typing.Tuple,
    'collections': collections, 'deque': collections.deque,
    'defaultdict': collections.defaultdict, 'Counter': collections.Counter,
    'OrderedDict': collections.OrderedDict,
    'heapq': heapq, 'bisect': bisect, 'math': math, 'itertools': itertools,
    'functools': functools, 'lru_cache': functools.lru_cache, 'cache': functools.cache,
    'string': string, 'inf': math.inf,
}

HIDDEN_TYPES = (
    types.ModuleType, types.FunctionType, types.BuiltinFunctionType,
    types.MethodType, type, functools.partial, typing._GenericAlias if hasattr(typing, '_GenericAlias') else type,
)
_NOTHING = object()


def _short(s, n=MAX_REPR):
    return s if len(s) <= n else s[: n - 1] + '…'


def _safe_repr(o):
    try:
        return _short(repr(o))
    except Exception:
        return f'<{type(o).__name__}>'


# ---------- snapshot encoding ----------

class Encoder:
    """Turns Python values into JSON. Objects get ids that stay stable across steps."""

    def __init__(self):
        self.ids = {}
        self.keep = []  # keeps objects alive so id() values are never reused

    def oid(self, o):
        k = id(o)
        n = self.ids.get(k)
        if n is None:
            n = self.ids[k] = len(self.ids) + 1
            self.keep.append(o)
        return n

    def value(self, v, heap, pending):
        if v is None:
            return {'k': 'none', 'r': 'None'}
        if isinstance(v, bool):
            return {'k': 'bool', 'r': repr(v)}
        if isinstance(v, int):
            out = {'k': 'int', 'r': _short(repr(v))}
            if -(2 ** 53) < v < 2 ** 53:
                out['n'] = int(v)
            return out
        if isinstance(v, float):
            return {'k': 'float', 'r': repr(v)}
        if isinstance(v, str):
            out = {'k': 'str', 'r': _short(repr(v))}
            if len(v) <= MAX_ITEMS:
                out['s'] = v
            return out
        if isinstance(v, complex):
            return {'k': 'other', 'r': repr(v)}
        n = self.oid(v)
        key = str(n)
        if key not in heap and len(heap) < MAX_OBJECTS:
            heap[key] = None
            pending.append(v)
        return {'k': 'ref', 'id': n}

    def encode(self, o, heap, pending):
        enc = lambda x: self.value(x, heap, pending)  # noqa: E731
        cls = type(o).__name__
        if isinstance(o, (list, tuple, collections.deque)):
            kind = 'list' if isinstance(o, list) else 'tuple' if isinstance(o, tuple) else 'deque'
            return {'t': kind, 'cls': cls, 'len': len(o),
                    'items': [enc(x) for x in itertools.islice(o, MAX_ITEMS)]}
        if isinstance(o, (set, frozenset)):
            items = list(o)
            if len(items) <= 1000:
                try:
                    items.sort()
                except Exception:
                    pass
            return {'t': 'set', 'cls': cls, 'len': len(o), 'items': [enc(x) for x in items[:MAX_ITEMS]]}
        if isinstance(o, dict):
            return {'t': 'dict', 'cls': cls, 'len': len(o),
                    'entries': [[enc(k), enc(v)] for k, v in itertools.islice(o.items(), MAX_ITEMS)]}
        if isinstance(o, (types.FunctionType, types.BuiltinFunctionType, types.MethodType, functools.partial)):
            return {'t': 'func', 'cls': cls, 'r': getattr(o, '__qualname__', None) or _safe_repr(o)}
        if isinstance(o, type):
            return {'t': 'class', 'cls': 'class', 'r': o.__name__}
        if isinstance(o, types.ModuleType):
            return {'t': 'other', 'cls': 'module', 'r': o.__name__}
        d = getattr(o, '__dict__', None)
        if isinstance(d, dict):
            attrs = [[k, enc(v)] for k, v in itertools.islice(d.items(), MAX_ITEMS) if not k.startswith('__')]
            return {'t': 'obj', 'cls': cls, 'attrs': attrs}
        return {'t': 'other', 'cls': cls, 'r': _safe_repr(o)}

    def drain(self, heap, pending):
        # Iterative so long linked lists / deep trees don't hit the recursion limit.
        while pending:
            o = pending.pop()
            heap[str(self.oid(o))] = self.encode(o, heap, pending)


def _visible_vars(mapping, is_module, enc, heap, pending):
    out = []
    for name, v in list(mapping.items()):
        if name.startswith('__'):
            continue
        if is_module and name in PRELOAD and v is PRELOAD[name]:
            continue
        if isinstance(v, HIDDEN_TYPES):
            continue
        if name == 'self' and getattr(v, '__dict__', None) == {}:
            continue
        out.append([name, enc.value(v, heap, pending)])
    return out


def _capture(enc, frames, event, line, out_len, ret=_NOTHING, exc=None, globals_only=None):
    heap, pending = {}, []
    stack = []
    if globals_only is not None:
        stack.append({'name': 'Global', 'vars': _visible_vars(globals_only, True, enc, heap, pending)})
    for f in frames:
        is_module = f.f_code.co_name == '<module>'
        stack.append({
            'name': 'Global' if is_module else f.f_code.co_name,
            'line': f.f_lineno,
            'vars': _visible_vars(f.f_locals, is_module, enc, heap, pending),
        })
    step = {'line': line, 'event': event, 'stack': stack, 'out': out_len}
    if ret is not _NOTHING:
        step['ret'] = enc.value(ret, heap, pending)
    if exc:
        step['exc'] = exc
    enc.drain(heap, pending)
    step['heap'] = heap
    return step


# ---------- I/O ----------

class _Output(io.TextIOBase):
    def __init__(self):
        self.parts = []
        self.n = 0
        self.cut = False

    def writable(self):
        return True

    def write(self, s):
        s = str(s)
        room = MAX_OUTPUT - self.n
        take = s[:room] if room > 0 else ''
        if take:
            self.parts.append(take)
            self.n += len(take)
        if len(take) < len(s):
            self.cut = True
        return len(s)

    def getvalue(self):
        return ''.join(self.parts) + ('\n[output truncated]' if self.cut else '')


def _make_builtins(stdin_io):
    b = dict(builtins.__dict__)

    def _input(prompt=''):
        if prompt:
            sys.stdout.write(str(prompt))
        line = stdin_io.readline()
        if not line:
            raise EOFError('input() ran out of lines. Add input in the stdin box.')
        return line[:-1] if line.endswith('\n') else line

    b['input'] = _input
    return b


# ---------- main entry ----------

def run_trace(code, stdin_text=''):
    enc = Encoder()
    steps = []
    out = _Output()
    stdin_io = io.StringIO(stdin_text or '')
    g = {'__name__': '__main__', '__builtins__': _make_builtins(stdin_io)}
    g.update(PRELOAD)
    result = {'ok': True, 'steps': steps, 'stdout': '', 'error': None, 'line': None, 'limit': False}

    try:
        compiled = compile(code, USER_FILE, 'exec')
    except SyntaxError as e:
        result.update(ok=False, error=f'SyntaxError: {e.msg}', line=e.lineno)
        return json.dumps(result)

    def is_class_body(frame):
        loc = frame.f_locals
        return frame.f_code.co_name != '<module>' and '__module__' in loc and '__qualname__' in loc

    def user_frames(frame):
        frames = []
        while frame is not None:
            if frame.f_code.co_filename == USER_FILE and not is_class_body(frame):
                frames.append(frame)
            frame = frame.f_back
        frames.reverse()
        return frames

    unwinding = set()  # frames currently propagating an exception

    def tracer(frame, event, arg):
        if frame.f_code.co_filename != USER_FILE:
            return None
        if event == 'call':
            return tracer
        if event == 'exception' and issubclass(arg[0], (StopIteration, StopAsyncIteration, GeneratorExit)):
            return tracer
        if event not in ('line', 'return', 'exception'):
            return tracer
        if is_class_body(frame):
            return tracer  # `class Solution:` bodies are setup noise
        if event == 'return' and frame.f_code.co_name == '<module>':
            return tracer  # the final "done" step covers this
        if len(steps) >= MAX_STEPS:
            raise StepLimit()

        kw = {}
        name = event
        if event == 'exception':
            unwinding.add(id(frame))
            kw['exc'] = f'{arg[0].__name__}: {arg[1]}'
        elif event == 'line':
            unwinding.discard(id(frame))
        elif event == 'return':
            if id(frame) in unwinding and arg is None:
                unwinding.discard(id(frame))
                name = 'unwind'
            else:
                kw['ret'] = arg
                if frame.f_code.co_flags & (inspect.CO_GENERATOR | inspect.CO_ASYNC_GENERATOR):
                    name = 'yield'
        steps.append(_capture(enc, user_frames(frame), name, frame.f_lineno, out.n, **kw))
        return tracer

    old_stdout, old_stdin, old_trace = sys.stdout, sys.stdin, sys.gettrace()
    sys.stdout, sys.stdin = out, stdin_io
    try:
        sys.settrace(tracer)
        exec(compiled, g)
    except StepLimit:
        result.update(limit=True, error=f'Stopped after {MAX_STEPS} steps. Is there an infinite loop? '
                                        f'Showing the first {MAX_STEPS} steps.')
    except SystemExit:
        pass
    except BaseException as e:  # user errors, including KeyboardInterrupt-like BaseExceptions
        sys.settrace(None)
        line = None
        tb = e.__traceback__
        while tb is not None:
            if tb.tb_frame.f_code.co_filename == USER_FILE:
                line = tb.tb_lineno
            tb = tb.tb_next
        result.update(ok=False, error=f'{type(e).__name__}: {e}', line=line)
    finally:
        sys.settrace(old_trace)
        sys.stdout, sys.stdin = old_stdout, old_stdin

    if not result['limit']:
        event = 'done' if result['ok'] else 'error'
        steps.append(_capture(enc, [], event, result['line'], out.n,
                              exc=result['error'], globals_only=g))
    result['stdout'] = out.getvalue()
    return json.dumps(result)
