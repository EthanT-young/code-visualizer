// Helpers for reading the step-by-step trace that all three tracers produce.

// Integer variables with these names are drawn as pointers into arrays and strings.
export const POINTER_RE = /^(?:[ijk]\d?|l|r|lo|hi|low|high|mid|left|right|start|end|begin|slow|fast|idx|index|ptr|pos|p\d?|q|top|front|rear|read|write|cur|curr|w)$|_(?:idx|index|ptr|pos|left|right|start|end)$/i;
// Pairs of integer variables that point at a cell in a 2D grid.
export const GRID_PAIRS = [['r', 'c'], ['row', 'col'], ['i', 'j'], ['nr', 'nc'], ['x', 'y']];
const POINTER_COLORS = 6;

export function colorIndex(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % POINTER_COLORS;
}

export const sig = (v) => (!v ? '' : v.k === 'ref' ? `#${v.id}` : `${v.k}:${v.r}`);
export const attr = (o, name) => o && o.attrs && (o.attrs.find((a) => a[0] === name) || [])[1];
const hasAttr = (o, name) => Boolean(o && o.attrs && o.attrs.some((a) => a[0] === name));
export const isTreeNode = (o) => Boolean(o && o.t === 'obj' && hasAttr(o, 'left') && hasAttr(o, 'right'));
export const isListNode = (o) => Boolean(o && o.t === 'obj' && hasAttr(o, 'next') && !isTreeNode(o));
export const isNode = (o) => isTreeNode(o) || isListNode(o);
export const nodeVal = (o) => attr(o, 'val') || attr(o, 'value') || attr(o, 'data') || attr(o, 'key');
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function childRef(heap, o, side, test) {
  const c = attr(o, side);
  return c && c.k === 'ref' && test(heap[c.id]) ? c.id : null;
}

/** Strings inside cells show without quotes; their color marks them as strings. */
export function cellText(v) {
  if (v.k === 'str' && v.s !== undefined) return v.s;
  return v.r;
}

const PY_BRACE_TYPES = ['dict', 'set', 'defaultdict', 'Counter', 'OrderedDict', 'frozenset'];

export function refLabel(id, heap) {
  const o = heap[id];
  if (!o) return '…';
  switch (o.t) {
    case 'list':
    case 'tuple':
    case 'deque':
      if (/\[\d*\]/.test(o.cls)) return o.cls.replace(/\[\d*\]/, `[${o.len}]`); // int[] -> int[4]
      if (o.cls === 'list' || o.cls === 'deque') return `${o.cls}[${o.len}]`;
      return `${o.cls}(${o.len})`;
    case 'dict':
    case 'set':
      return PY_BRACE_TYPES.includes(o.cls) ? `${o.cls}{${o.len}}` : `${o.cls}(${o.len})`;
    case 'obj': {
      const val = nodeVal(o);
      return val ? `${o.cls}(${cellText(val)})` : o.cls;
    }
    case 'func': return `function ${o.r}`;
    case 'class': return `class ${o.r}`;
    default: return o.r || o.cls;
  }
}

export function shortRepr(v, heap, depth = 0) {
  if (!v) return '';
  if (v.k !== 'ref') return v.r;
  const o = heap[v.id];
  if (!o || depth > 1) return refLabel(v.id, heap);
  const more = (o.len || 0) > 6 ? ', …' : '';
  const items = () => o.items.slice(0, 6).map((x) => shortRepr(x, heap, depth + 1)).join(', ');
  if (o.t === 'list' || o.t === 'deque') return `[${items()}${more}]`;
  if (o.t === 'tuple') return `(${items()}${more})`;
  if (o.t === 'set') return `{${items()}${more}}`;
  if (o.t === 'dict') {
    const entries = o.entries.slice(0, 4).map(([k, x]) => `${shortRepr(k, heap, depth + 1)}: ${shortRepr(x, heap, depth + 1)}`);
    return `{${entries.join(', ')}${o.len > 4 ? ', …' : ''}}`;
  }
  return refLabel(v.id, heap);
}

export const frameLabel = (name) => (name === 'Global' || name.includes(' ') ? name : `${name}()`);

/** One line describing a step, plus a tone for the status bar. */
export function describeStep(step, trace) {
  const top = step.stack[step.stack.length - 1];
  const where = top && top.name !== 'Global' && !top.name.includes(' ') ? ` in ${top.name}()` : '';
  switch (step.event) {
    case 'line': return [`Next to run: line ${step.line}${where}`, ''];
    case 'return': return [`${top.name}() returns${step.ret ? ` ${shortRepr(step.ret, step.heap)}` : ''}`, 'ret'];
    case 'yield': return [`${top.name}() yields ${shortRepr(step.ret, step.heap)}`, 'ret'];
    case 'exception': return [`${step.exc} on line ${step.line}${where}`, 'error'];
    case 'unwind': return [`${top.name}() exits early because of the exception`, 'error'];
    case 'error': return [`${trace.error}${trace.line ? ` (line ${trace.line})` : ''}`, 'error'];
    case 'done': return ['Finished', 'done'];
    default: return ['', ''];
  }
}

/** object id -> [{ name, frame }] for every variable that refers to it. */
export function collectRefs(stack) {
  const refs = new Map();
  stack.forEach((frame, f) => {
    for (const [name, v] of frame.vars) {
      if (v.k !== 'ref') continue;
      if (!refs.has(v.id)) refs.set(v.id, []);
      refs.get(v.id).push({ name, frame: f });
    }
  });
  return refs;
}

/** Variable names pointing at an object; the current frame's names first. */
export function namesFor(id, ctx) {
  const list = ctx.refs.get(id) || [];
  const seen = new Set();
  const out = [];
  for (const r of [...list].sort((a, b) => b.frame - a.frame)) {
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    out.push({ name: r.name, current: r.frame === ctx.top });
  }
  return out;
}

/** index -> [{ name, current }] for pointer-like int variables in the given frames. */
export function pointerMap(len, frameIdxs, ctx) {
  const map = new Map();
  for (const f of frameIdxs) {
    const frame = ctx.stack[f];
    if (!frame) continue;
    for (const [name, v] of frame.vars) {
      if (v.k !== 'int' || v.n === undefined || !POINTER_RE.test(name)) continue;
      if (v.n < 0 || v.n > len) continue;
      if (!map.has(v.n)) map.set(v.n, []);
      const list = map.get(v.n);
      if (!list.some((p) => p.name === name)) list.push({ name, current: f === ctx.top });
    }
  }
  return map;
}

export const framePointerVars = (frame) => frame.vars.some(([name, v]) => v.k === 'int' && POINTER_RE.test(name));

export function isGrid(o, heap) {
  if (!['list', 'tuple'].includes(o.t) || !o.items.length) return false;
  return o.items.every((v) => {
    const row = v.k === 'ref' && heap[v.id];
    return row && ['list', 'tuple'].includes(row.t) && row.items.length <= 40 && row.items.every((x) => x.k !== 'ref');
  });
}

export function typeLabel(o) {
  switch (o.t) {
    case 'list':
    case 'deque':
    case 'set': return `${o.cls}, ${plural(o.len, 'item')}`;
    case 'tuple': return `${o.cls}, ${plural(o.len, 'item')}`;
    case 'dict': return `${o.cls}, ${plural(o.len, 'key')}`;
    default: return o.cls || '';
  }
}

/** Linked lists: chains of nodes following .next, each with how it ends. */
export function buildChains(heap) {
  const ids = Object.keys(heap).map(Number).filter((id) => isListNode(heap[id]));
  const isNext = new Set();
  for (const id of ids) {
    const n = childRef(heap, heap[id], 'next', isListNode);
    if (n != null) isNext.add(n);
  }
  const starts = [...ids.filter((id) => !isNext.has(id)), ...ids]; // leftovers are pure cycles
  const chainOf = new Map();
  const chains = [];
  for (const start of starts) {
    if (chainOf.has(start)) continue;
    const chain = { nodes: [], end: { kind: 'none' } };
    let cur = start;
    while (cur != null) {
      if (chainOf.has(cur)) {
        chain.end = chain.nodes.includes(cur) ? { kind: 'cycle', id: cur } : { kind: 'joins', id: cur };
        break;
      }
      if (chain.nodes.length >= 40) {
        chain.end = { kind: 'more' };
        break;
      }
      chain.nodes.push(cur);
      chainOf.set(cur, chains.length);
      const o = heap[cur];
      const nextVal = attr(o, 'next');
      const nxt = childRef(heap, o, 'next', isListNode);
      if (nxt == null && nextVal && nextVal.k !== 'none') chain.end = { kind: 'value', v: nextVal };
      cur = nxt;
    }
    chains.push(chain);
  }
  return { chains, chainOf };
}

/** Binary trees: in-order x position and depth for each node, per root. */
export function buildTrees(heap) {
  const ids = Object.keys(heap).map(Number).filter((id) => isTreeNode(heap[id]));
  const isChild = new Set();
  for (const id of ids) {
    for (const side of ['left', 'right']) {
      const c = childRef(heap, heap[id], side, isTreeNode);
      if (c != null) isChild.add(c);
    }
  }
  const rootOf = new Map();
  const trees = [];
  for (const root of [...ids.filter((id) => !isChild.has(id)), ...ids]) {
    if (rootOf.has(root)) continue;
    const pos = new Map();
    let count = 0;
    let maxDepth = 0;
    let truncated = false;
    const walk = (id, d) => {
      if (pos.has(id) || rootOf.has(id)) return;
      if (count >= 127 || d > 30) {
        truncated = true;
        return;
      }
      rootOf.set(id, root);
      const o = heap[id];
      const l = childRef(heap, o, 'left', isTreeNode);
      const r = childRef(heap, o, 'right', isTreeNode);
      if (l != null) walk(l, d + 1);
      pos.set(id, { x: count++, d });
      maxDepth = Math.max(maxDepth, d);
      if (r != null) walk(r, d + 1);
    };
    walk(root, 0);
    trees.push({ root, pos, count, maxDepth, truncated });
  }
  return { trees, rootOf };
}
