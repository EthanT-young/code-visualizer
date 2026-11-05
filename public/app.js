'use strict';

// Integer variables with these names are drawn as pointers into arrays and strings.
const POINTER_RE = /^(?:[ijk]\d?|l|r|lo|hi|low|high|mid|left|right|start|end|begin|slow|fast|idx|index|ptr|pos|p\d?|q|top|front|rear|read|write|cur|curr|w)$|_(?:idx|index|ptr|pos|left|right|start|end)$/i;
// Pairs of integer variables that point at a cell in a 2D grid.
const GRID_PAIRS = [['r', 'c'], ['row', 'col'], ['i', 'j'], ['nr', 'nc'], ['x', 'y']];
const POINTER_COLORS = 6;
const NIL = { python: 'None', java: 'null', cpp: 'nullptr' };
const RUN_TIMEOUT_MS = 12000;
const AUTORUN_DELAY_MS = 700;
const SERVER_AUTORUN_DELAY_MS = 1200;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

// Absolute URLs built from location (which never holds credentials). Relative URLs
// resolve against the document's base URL, which keeps "user:pass@" when someone opens
// https://user:pass@host/…, and the browser then refuses the request.
const appUrl = (path) => new URL(path, `${location.origin}${location.pathname}`).href;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function colorIndex(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % POINTER_COLORS;
}

const sig = (v) => (!v ? '' : v.k === 'ref' ? `#${v.id}` : `${v.k}:${v.r}`);
const attr = (o, name) => o && o.attrs && (o.attrs.find((a) => a[0] === name) || [])[1];
const hasAttr = (o, name) => Boolean(o && o.attrs && o.attrs.some((a) => a[0] === name));
const isTreeNode = (o) => Boolean(o && o.t === 'obj' && hasAttr(o, 'left') && hasAttr(o, 'right'));
const isListNode = (o) => Boolean(o && o.t === 'obj' && hasAttr(o, 'next') && !isTreeNode(o));
const isNode = (o) => isTreeNode(o) || isListNode(o);
const nodeVal = (o) => attr(o, 'val') || attr(o, 'value') || attr(o, 'data') || attr(o, 'key');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function childRef(heap, o, side, test) {
  const c = attr(o, side);
  return c && c.k === 'ref' && test(heap[c.id]) ? c.id : null;
}

function cellText(v) {
  // Show strings inside cells without quotes; the color marks them as strings.
  if (v.k === 'str' && v.s !== undefined) return v.s;
  return v.r;
}

function refLabel(id, heap) {
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
      return ['dict', 'set', 'defaultdict', 'Counter', 'OrderedDict', 'frozenset'].includes(o.cls) ? `${o.cls}{${o.len}}` : `${o.cls}(${o.len})`;
    case 'obj': {
      const val = nodeVal(o);
      return val ? `${o.cls}(${cellText(val)})` : o.cls;
    }
    case 'func': return `function ${o.r}`;
    case 'class': return `class ${o.r}`;
    default: return o.r || o.cls;
  }
}

function shortRepr(v, heap, depth = 0) {
  if (!v) return '';
  if (v.k !== 'ref') return v.r;
  const o = heap[v.id];
  if (!o || depth > 1) return refLabel(v.id, heap);
  const more = (o.len || 0) > 6 ? ', …' : '';
  if (o.t === 'list' || o.t === 'deque') return `[${o.items.slice(0, 6).map((x) => shortRepr(x, heap, depth + 1)).join(', ')}${more}]`;
  if (o.t === 'tuple') return `(${o.items.slice(0, 6).map((x) => shortRepr(x, heap, depth + 1)).join(', ')}${more})`;
  if (o.t === 'set') return `{${o.items.slice(0, 6).map((x) => shortRepr(x, heap, depth + 1)).join(', ')}${more}}`;
  if (o.t === 'dict') return `{${o.entries.slice(0, 4).map(([k, x]) => `${shortRepr(k, heap, depth + 1)}: ${shortRepr(x, heap, depth + 1)}`).join(', ')}${o.len > 4 ? ', …' : ''}}`;
  return refLabel(v.id, heap);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  lang: 'java',
  trace: null,
  step: 0,
  playing: false,
  playTimer: null,
  worker: null,
  ready: false,
  runId: 0,
  pending: null,       // { id, reset } for the run whose result we're waiting for
  queuedRun: null,     // a Python run requested while Python is still loading
  killTimer: null,
  autorunTimer: null,
  skipNextAutorun: false,
  request: null,       // AbortController for the in-flight server request
  lineMarks: [],
};

let editor;

// ---------------------------------------------------------------------------
// Running code: Python in a Web Worker, Java and C++ on the server
// ---------------------------------------------------------------------------

function startWorker() {
  state.ready = false;
  const worker = new Worker(appUrl('worker.js'));
  worker.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === 'ready') {
      state.ready = true;
      const queued = state.queuedRun;
      state.queuedRun = null;
      if (state.skipNextAutorun) {
        state.skipNextAutorun = false;
      } else if (queued && state.lang === 'python') {
        run(queued);
      }
    } else if (msg.type === 'fatal') {
      setStatus(`Python couldn't load (${msg.error}). Check your internet connection, then reload the page.`, 'error');
    } else if (msg.type === 'result') {
      finishRun(msg.id, () => JSON.parse(msg.json));
    }
  };
  worker.onerror = (event) => {
    setStatus(`Python couldn't start: ${event.message || 'unknown error'}. Serve this folder over http instead of opening the file directly (see README).`, 'error');
  };
  state.worker = worker;
}

function finishRun(id, getTrace) {
  if (!state.pending || id !== state.pending.id) return;
  clearTimeout(state.killTimer);
  const { reset } = state.pending;
  state.pending = null;
  let trace;
  try {
    trace = getTrace();
  } catch {
    trace = { ok: false, steps: [], stdout: '', error: 'The visualizer received a broken trace.', line: null };
  }
  applyTrace(trace, reset);
}

function run({ reset = false } = {}) {
  const lang = state.lang;
  const id = ++state.runId;
  // A newer run replaces an older one; keep "reset" if any queued run asked for it.
  state.pending = { id, reset: reset || Boolean(state.pending && state.pending.reset), lang };
  const code = editor.getValue();
  const stdin = $('#stdin').value;
  $('#run').textContent = 'Running…';
  clearTimeout(state.killTimer);

  if (lang === 'python') {
    if (!state.worker) startWorker();
    if (!state.ready) {
      state.queuedRun = { reset: state.pending.reset };
      state.pending = null;
      setStatus('Loading Python in your browser. The first load takes a few seconds.');
      return;
    }
    state.worker.postMessage({ id, code, stdin });
    state.killTimer = setTimeout(() => {
      if (!state.pending || state.pending.id !== id) return;
      state.pending = null;
      state.worker.terminate();
      state.worker = null;
      state.skipNextAutorun = true;
      $('#run').textContent = 'Run';
      setStatus(`Stopped after ${RUN_TIMEOUT_MS / 1000} seconds without finishing. Look for a loop that never ends, then edit the code or press Run.`, 'error');
      startWorker();
    }, RUN_TIMEOUT_MS);
    return;
  }

  if (state.request) state.request.abort();
  const controller = new AbortController();
  state.request = controller;
  if (!state.trace) setStatus(`Compiling and running your ${LANGUAGES[lang].label} code…`);
  fetch(appUrl('api/trace'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language: lang, code, stdin }),
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok && res.status !== 413 && res.status !== 400) throw new Error(`server responded ${res.status}`);
      const trace = await res.json();
      finishRun(id, () => trace);
    })
    .catch((err) => {
      if (err.name === 'AbortError' || !state.pending || state.pending.id !== id) return;
      state.pending = null;
      $('#run').textContent = 'Run';
      setStatus(`Couldn't reach the server that runs ${LANGUAGES[lang].label} code (${err.message}). Python still works without it.`, 'error');
    });
}

function scheduleAutorun() {
  persist();
  if (!$('#autorun').checked) return;
  clearTimeout(state.autorunTimer);
  const delay = LANGUAGES[state.lang].server ? SERVER_AUTORUN_DELAY_MS : AUTORUN_DELAY_MS;
  state.autorunTimer = setTimeout(() => run(), delay);
}

// ---------------------------------------------------------------------------
// Trace navigation
// ---------------------------------------------------------------------------

function applyTrace(trace, reset) {
  $('#run').textContent = 'Run';
  state.trace = trace;
  const n = trace.steps.length;
  state.step = reset ? 0 : Math.min(state.step, Math.max(0, n - 1));
  $('#scrub').max = String(Math.max(0, n - 1));
  if (!n) stopPlaying();
  render();
}

function setStep(index) {
  if (!state.trace || !state.trace.steps.length) return;
  const last = state.trace.steps.length - 1;
  state.step = Math.max(0, Math.min(last, index));
  render();
}

function stopPlaying() {
  state.playing = false;
  clearInterval(state.playTimer);
  $('#play').textContent = 'Play';
}

function togglePlay() {
  if (state.playing) {
    stopPlaying();
    return;
  }
  if (!state.trace || state.trace.steps.length < 2) return;
  if (state.step >= state.trace.steps.length - 1) setStep(0);
  state.playing = true;
  $('#play').textContent = 'Pause';
  state.playTimer = setInterval(() => {
    if (state.step >= state.trace.steps.length - 1) stopPlaying();
    else setStep(state.step + 1);
  }, Number($('#speed').value));
}

// ---------------------------------------------------------------------------
// Rendering: status, output, editor lines
// ---------------------------------------------------------------------------

function setStatus(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = kind ? `status is-${kind}` : 'status';
}

function describeStep(step, trace) {
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

function markLines(current, previous, isError) {
  // Line handles follow their line when the code above is edited.
  for (const [handle, cls] of state.lineMarks) editor.removeLineClass(handle, 'wrap', cls);
  state.lineMarks = [];
  const add = (line, cls) => {
    if (line == null || line < 1 || line > editor.lineCount()) return;
    state.lineMarks.push([editor.addLineClass(line - 1, 'wrap', cls), cls]);
  };
  if (previous && previous !== current) add(previous, 'line-prev');
  add(current, isError ? 'line-error' : 'line-next');
  if (current) editor.scrollIntoView({ line: current - 1, ch: 0 }, 80);
}

function render() {
  const trace = state.trace;
  const steps = trace ? trace.steps : [];
  const step = steps[state.step];
  const prevStep = state.step > 0 ? steps[state.step - 1] : null;

  $('#scrub').value = String(state.step);
  $('#counter').textContent = steps.length ? `${state.step + 1} / ${steps.length}` : '0 / 0';
  for (const id of ['first', 'prev']) $(`#${id}`).disabled = !step || state.step === 0;
  for (const id of ['next', 'last', 'play']) $(`#${id}`).disabled = !step || state.step >= steps.length - 1 && !state.playing;
  if (step && steps.length > 1) $('#play').disabled = false;

  if (!trace) return;

  if (!step) {
    // Syntax error: nothing ran.
    setStatus(`${trace.error}${trace.line ? ` (line ${trace.line})` : ''}`, 'error');
    markLines(trace.line, null, true);
    $('#frames').innerHTML = '';
    $('#objects').innerHTML = '';
    $('#stdout').textContent = '';
    return;
  }

  let [text, kind] = describeStep(step, trace);
  if (trace.limit && state.step === steps.length - 1) {
    text = trace.error;
    kind = 'error';
  }
  setStatus(text, kind);

  const isLast = state.step === steps.length - 1;
  $('#stdout').textContent = isLast ? trace.stdout : trace.stdout.slice(0, step.out);
  $('#stdout').scrollTop = $('#stdout').scrollHeight;

  const errorLine = step.event === 'exception' || step.event === 'error';
  markLines(step.line, prevStep && prevStep.event !== 'done' ? prevStep.line : null, errorLine);

  const refs = collectRefs(step.stack);
  $('#frames').innerHTML = renderFrames(step, prevStep);
  $('#objects').innerHTML = renderObjects(step, prevStep, refs);
}

// ---------------------------------------------------------------------------
// Rendering: call stack
// ---------------------------------------------------------------------------

function valueChip(v, heap) {
  if (!v) return '';
  if (v.k !== 'ref') return `<span class="v v-${v.k}">${esc(v.r)}</span>`;
  return `<span class="chip" data-ref="${v.id}" tabindex="0">${esc(refLabel(v.id, heap))}</span>`;
}

function renderFrames(step, prevStep) {
  const html = [];
  for (let f = step.stack.length - 1; f >= 0; f--) {
    const frame = step.stack[f];
    const isTop = f === step.stack.length - 1;
    const prevFrame = prevStep && prevStep.stack[f] && prevStep.stack[f].name === frame.name ? prevStep.stack[f] : null;
    const prevVars = prevFrame ? new Map(prevFrame.vars.map(([n, v]) => [n, sig(v)])) : null;
    const rows = frame.vars.map(([name, v]) => {
      const changed = prevVars && prevVars.get(name) !== sig(v);
      return `<tr${changed ? ' class="changed"' : ''}><th scope="row">${esc(name)}</th><td>${valueChip(v, step.heap)}</td></tr>`;
    }).join('');
    let ret = '';
    if (isTop && (step.event === 'return' || step.event === 'yield')) {
      ret = `<div class="ret">${step.event === 'yield' ? 'yields' : 'returns'} ${valueChip(step.ret, step.heap)}</div>`;
    }
    const label = frame.name === 'Global' || frame.name.includes(' ') ? frame.name : `${frame.name}()`;
    html.push(`
      <section class="frame${isTop ? ' current' : ''}">
        <h3>${esc(label)}${frame.line && !isTop ? `<span class="at">line ${frame.line}</span>` : ''}</h3>
        ${rows ? `<table class="vars">${rows}</table>` : '<p class="none">No variables yet</p>'}
        ${ret}
      </section>`);
  }
  return html.join('');
}

// ---------------------------------------------------------------------------
// Rendering: data structures
// ---------------------------------------------------------------------------

function collectRefs(stack) {
  // object id -> [{ name, frame }]
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

function namesFor(id, ctx) {
  const list = ctx.refs.get(id) || [];
  const seen = new Set();
  const out = [];
  // Current frame's names first.
  for (const r of [...list].sort((a, b) => b.frame - a.frame)) {
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    out.push({ name: r.name, current: r.frame === ctx.top });
  }
  return out;
}

function pointerMap(len, frameIdxs, ctx) {
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

function framePointerVars(frame) {
  return frame.vars.some(([name, v]) => v.k === 'int' && POINTER_RE.test(name));
}

function ptrLabels(list) {
  return `<div class="ptrs">${list.map((p) => `<span class="ptr c${colorIndex(p.name)}${p.current ? '' : ' faded'}">${esc(p.name)}</span>`).join('')}</div>`;
}

function renderValue(v, ctx, depth) {
  if (!v) return '';
  if (v.k !== 'ref') return `<span class="v v-${v.k}">${esc(depth > 0 ? cellText(v) : v.r)}</span>`;
  const o = ctx.heap[v.id];
  if (!o || depth >= 3 || ctx.seen.has(v.id) || isNode(o) || o.t === 'obj') {
    return `<span class="chip" data-ref="${v.id}">${esc(refLabel(v.id, ctx.heap))}</span>`;
  }
  ctx.seen.add(v.id);
  const html = renderBody(v.id, o, ctx, depth, null);
  ctx.seen.delete(v.id);
  return `<div class="nested" data-obj="${v.id}">${html}</div>`;
}

function isGrid(o, heap) {
  if (!['list', 'tuple'].includes(o.t) || !o.items.length) return false;
  return o.items.every((v) => {
    const row = v.k === 'ref' && heap[v.id];
    return row && ['list', 'tuple'].includes(row.t) && row.items.length <= 40 && row.items.every((x) => x.k !== 'ref');
  });
}

function renderBody(id, o, ctx, depth, ptrs) {
  switch (o.t) {
    case 'list':
    case 'tuple':
    case 'deque':
      if (depth === 0 && isGrid(o, ctx.heap)) return renderGrid(id, o, ctx);
      return renderArray(id, o.items, o.len, ctx, depth, ptrs);
    case 'dict': return renderDict(id, o, ctx, depth);
    case 'set': return renderSet(id, o, ctx, depth);
    case 'obj': return renderAttrs(id, o, ctx, depth);
    default: return `<span class="v v-other">${esc(o.r || o.cls)}</span>`;
  }
}

function renderArray(id, items, len, ctx, depth, ptrs) {
  const prev = id != null && ctx.prevHeap ? ctx.prevHeap[id] : null;
  const prevItems = prev && prev.items;
  const showPtrs = ptrs && ptrs.size > 0;
  const slots = items.map((v, i) => {
    const changed = prevItems && (i >= prevItems.length || sig(prevItems[i]) !== sig(v));
    const p = (showPtrs && ptrs.get(i)) || [];
    return `<div class="slot${p.length ? ' pointed' : ''}">${showPtrs ? ptrLabels(p) : ''}<div class="cell${changed ? ' changed' : ''}">${renderValue(v, ctx, depth + 1)}</div><div class="idx">${i}</div></div>`;
  });
  if (len > items.length) slots.push(`<div class="slot more"><div class="cell">+${len - items.length}</div></div>`);
  const endPtr = showPtrs && ptrs.get(len);
  if (endPtr && len <= items.length) {
    slots.push(`<div class="slot pointed end">${ptrLabels(endPtr)}<div class="cell"></div><div class="idx">${len}</div></div>`);
  }
  if (!slots.length) return '<span class="empty">empty</span>';
  return `<div class="arr">${slots.join('')}</div>`;
}

function renderGrid(id, o, ctx) {
  const prev = ctx.prevHeap && ctx.prevHeap[id];
  const rows = o.items.map((v) => ctx.heap[v.id]);
  const cols = Math.max(...rows.map((r) => r.items.length));
  const marks = new Map();
  for (const f of new Set([ctx.top, ...(ctx.refs.get(id) || []).map((r) => r.frame)])) {
    const vars = new Map((ctx.stack[f] ? ctx.stack[f].vars : []).map(([n, v]) => [n, v]));
    for (const [a, b] of GRID_PAIRS) {
      const r = vars.get(a);
      const c = vars.get(b);
      if (!r || !c || r.n === undefined || c.n === undefined) continue;
      if (r.n < 0 || r.n >= rows.length || c.n < 0 || c.n >= cols) continue;
      const key = `${r.n},${c.n}`;
      if (!marks.has(key)) marks.set(key, []);
      marks.get(key).push({ name: `${a},${b}`, current: f === ctx.top });
    }
  }
  let head = '<tr><th></th>';
  for (let c = 0; c < cols; c++) head += `<th scope="col">${c}</th>`;
  head += '</tr>';
  const body = rows.map((row, r) => {
    const rowId = o.items[r].id;
    const prevRow = prev && ctx.prevHeap[rowId];
    const cells = row.items.map((v, c) => {
      const changed = prevRow && sig(prevRow.items[c]) !== sig(v);
      const m = marks.get(`${r},${c}`);
      const title = m ? ` title="${esc(m.map((x) => x.name).join(' / '))}"` : '';
      const cls = [changed && 'changed', m && 'pointed', m && !m.some((x) => x.current) && 'faded'].filter(Boolean).join(' ');
      return `<td${cls ? ` class="${cls}"` : ''}${title}><span class="v v-${v.k}">${esc(cellText(v))}</span></td>`;
    }).join('');
    return `<tr><th scope="row">${r}</th>${cells}</tr>`;
  }).join('');
  const legend = [...new Set([...marks.values()].flat().map((m) => m.name))];
  return `<table class="grid">${head}${body}</table>${legend.length ? `<p class="legend">Outlined: cell at (${esc(legend.join('), ('))})</p>` : ''}`;
}

function renderDict(id, o, ctx, depth) {
  if (!o.entries.length) return '<span class="empty">empty</span>';
  const prev = ctx.prevHeap && ctx.prevHeap[id];
  const prevMap = prev && prev.entries ? new Map(prev.entries.map(([k, v]) => [sig(k), sig(v)])) : null;
  const rows = o.entries.map(([k, v]) => {
    const changed = prevMap && prevMap.get(sig(k)) !== sig(v);
    return `<tr${changed ? ' class="changed"' : ''}><td class="key">${renderValue(k, ctx, depth + 1)}</td><td>${renderValue(v, ctx, depth + 1)}</td></tr>`;
  }).join('');
  const more = o.len > o.entries.length ? `<tr><td colspan="2" class="empty">+${o.len - o.entries.length} more</td></tr>` : '';
  return `<table class="kv">${rows}${more}</table>`;
}

function renderSet(id, o, ctx, depth) {
  if (!o.items.length) return '<span class="empty">empty</span>';
  const prev = ctx.prevHeap && ctx.prevHeap[id];
  const before = prev && prev.items ? new Set(prev.items.map(sig)) : null;
  const items = o.items.map((v) => `<span class="set-item${before && !before.has(sig(v)) ? ' changed' : ''}">${renderValue(v, ctx, depth + 1)}</span>`).join('');
  return `<div class="set">${items}${o.len > o.items.length ? `<span class="empty">+${o.len - o.items.length}</span>` : ''}</div>`;
}

function renderAttrs(id, o, ctx, depth) {
  if (!o.attrs.length) return `<span class="empty">${esc(o.cls)} with no attributes</span>`;
  const prev = ctx.prevHeap && ctx.prevHeap[id];
  const prevMap = prev && prev.attrs ? new Map(prev.attrs.map(([k, v]) => [k, sig(v)])) : null;
  const rows = o.attrs.map(([k, v]) => {
    const changed = prevMap && prevMap.get(k) !== sig(v);
    // Attributes holding containers render inline, one level deep.
    const ref = v.k === 'ref' && ctx.heap[v.id];
    const inner = ref && !isNode(ref) && ref.t !== 'obj' && depth < 2 && !ctx.seen.has(v.id)
      ? (() => { ctx.seen.add(v.id); const h = `<div class="nested" data-obj="${v.id}">${renderBody(v.id, ref, ctx, depth + 1, null)}</div>`; ctx.seen.delete(v.id); return h; })()
      : renderValue(v, ctx, depth + 1);
    return `<tr${changed ? ' class="changed"' : ''}><th scope="row">.${esc(k)}</th><td>${inner}</td></tr>`;
  }).join('');
  return `<table class="kv attrs">${rows}</table>`;
}

// ---- linked lists -------------------------------------------------------

function buildChains(heap) {
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
  // A cycle found while walking: mark the cycle edge correctly.
  for (const chain of chains) {
    const lastId = chain.nodes[chain.nodes.length - 1];
    const nxt = childRef(heap, heap[lastId], 'next', isListNode);
    if (nxt != null && chain.end.kind === 'none') {
      chain.end = chain.nodes.includes(nxt) ? { kind: 'cycle', id: nxt } : { kind: 'joins', id: nxt };
    }
  }
  return { chains, chainOf };
}

function renderChain(chain, ctx) {
  const heap = ctx.heap;
  const parts = chain.nodes.map((id) => {
    const o = heap[id];
    const prev = ctx.prevHeap && ctx.prevHeap[id];
    const changed = prev && (sig(attr(prev, 'next')) !== sig(attr(o, 'next')) || sig(nodeVal(prev)) !== sig(nodeVal(o)));
    const names = namesFor(id, ctx);
    const val = nodeVal(o);
    return `<div class="ll-node${names.some((n) => n.current) ? ' pointed' : ''}" data-obj="${id}">
      ${ptrLabels(names)}
      <div class="node-box${changed ? ' changed' : ''}"><span class="node-val">${val ? renderValue(val, ctx, 1) : esc(o.cls)}</span><span class="node-next" aria-hidden="true"></span></div>
    </div>`;
  });
  let tail;
  const end = chain.end;
  if (end.kind === 'cycle') tail = `<span class="ll-end cycle">back to ${esc(cellText(nodeVal(heap[end.id]) || { r: '?' }))}</span>`;
  else if (end.kind === 'joins') tail = `<span class="ll-end">joins ${esc(refLabel(end.id, heap))}</span>`;
  else if (end.kind === 'more') tail = '<span class="ll-end">…</span>';
  else if (end.kind === 'value') tail = `<span class="ll-end">${renderValue(end.v, ctx, 1)}</span>`;
  else tail = `<span class="ll-end none">${NIL[state.lang] || 'None'}</span>`;
  return `<div class="ll">${parts.join('<span class="ll-arrow" aria-hidden="true">→</span>')}<span class="ll-arrow" aria-hidden="true">→</span>${tail}</div>`;
}

// ---- binary trees ------------------------------------------------------

function buildTrees(heap) {
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

function renderTree(tree, ctx) {
  const heap = ctx.heap;
  const X = (p) => 26 + p.x * 46;
  const Y = (p) => 24 + p.d * 66;
  const width = 52 + Math.max(0, tree.count - 1) * 46;
  const height = 24 + tree.maxDepth * 66 + 44;
  const edges = [];
  const nodes = [];
  for (const [id, p] of tree.pos) {
    const o = heap[id];
    for (const side of ['left', 'right']) {
      const c = childRef(heap, o, side, isTreeNode);
      const cp = c != null && tree.pos.get(c);
      if (cp) edges.push(`<line x1="${X(p)}" y1="${Y(p)}" x2="${X(cp)}" y2="${Y(cp)}"/>`);
    }
  }
  for (const [id, p] of tree.pos) {
    const o = heap[id];
    const prev = ctx.prevHeap && ctx.prevHeap[id];
    const changed = prev && ['left', 'right', 'val'].some((k) => sig(attr(prev, k)) !== sig(attr(o, k)));
    const names = namesFor(id, ctx);
    const val = nodeVal(o);
    let text = val ? cellText(val) : '?';
    if (text.length > 4) text = `${text.slice(0, 3)}…`;
    const cls = ['tnode', names.some((n) => n.current) && 'pointed', names.length && !names.some((n) => n.current) && 'pointed-faded', changed && 'changed'].filter(Boolean).join(' ');
    const label = names.length
      ? `<text class="tlabel" x="${X(p)}" y="${Y(p) + 33}">${esc(names.map((n) => n.name).join(', '))}</text>`
      : '';
    nodes.push(`<g class="${cls}" data-obj="${id}"><circle cx="${X(p)}" cy="${Y(p)}" r="17"/><text class="tval" x="${X(p)}" y="${Y(p) + 5}">${esc(text)}</text>${label}</g>`);
  }
  return `<div class="tree-wrap"><svg class="tree" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Binary tree">${edges.join('')}${nodes.join('')}</svg>${tree.truncated ? '<p class="legend">Large tree: showing the first 127 nodes.</p>' : ''}</div>`;
}

// ---- assembling the data column ------------------------------------------

function typeLabel(o) {
  switch (o.t) {
    case 'list':
    case 'deque': return `${o.cls}, ${plural(o.len, 'item')}`;
    case 'tuple': return `tuple, ${plural(o.len, 'item')}`;
    case 'dict': return `${o.cls}, ${plural(o.len, 'key')}`;
    case 'set': return `${o.cls}, ${plural(o.len, 'item')}`;
    case 'obj': return o.cls;
    default: return o.cls || '';
  }
}

function card(names, type, body, objId) {
  const title = `<span class="names">${names.length
    ? names.map((n) => `<span class="${n.current ? 'name' : 'name faded'}">${esc(n.name)}</span>`).join(', ')
    : '<span class="name faded">unnamed</span>'}</span>`;
  return `<figure class="card"${objId != null ? ` data-obj="${objId}"` : ''}><figcaption>${title}<span class="type">${esc(type)}</span></figcaption>${body}</figure>`;
}

function renderObjects(step, prevStep, refs) {
  const heap = step.heap;
  const ctx = {
    heap,
    prevHeap: prevStep ? prevStep.heap : null,
    stack: step.stack,
    top: step.stack.length - 1,
    refs,
    seen: new Set(),
  };
  const { chains, chainOf } = buildChains(heap);
  const { trees, rootOf } = buildTrees(heap);
  const done = new Set();
  const cards = [];

  const addObject = (id, fallbackName) => {
    const o = heap[id];
    if (!o) return;
    if (isListNode(o)) {
      const c = chainOf.get(id);
      if (c == null || done.has(`L${c}`)) return;
      done.add(`L${c}`);
      const headNames = namesFor(chains[c].nodes[0], ctx);
      cards.push(card(headNames.length ? headNames : [{ name: fallbackName || 'linked list', current: false }], 'linked list', renderChain(chains[c], ctx)));
      return;
    }
    if (isTreeNode(o)) {
      const r = rootOf.get(id);
      const t = trees.find((x) => x.root === r);
      if (!t || done.has(`T${r}`)) return;
      done.add(`T${r}`);
      const rootNames = namesFor(r, ctx);
      cards.push(card(rootNames.length ? rootNames : [{ name: fallbackName || 'tree', current: false }], 'binary tree', renderTree(t, ctx)));
      return;
    }
    if (['func', 'class', 'other'].includes(o.t) || done.has(`O${id}`)) return;
    if (o.t === 'obj' && !o.attrs.length) return;
    done.add(`O${id}`);
    let ptrs = null;
    if (['list', 'tuple', 'deque'].includes(o.t)) {
      const frames = new Set([ctx.top, ...(refs.get(id) || []).map((r) => r.frame)]);
      ptrs = pointerMap(o.len, frames, ctx);
    }
    const names = namesFor(id, ctx);
    ctx.seen.add(id);
    cards.push(card(names.length ? names : [{ name: fallbackName || 'value', current: false }], typeLabel(o), renderBody(id, o, ctx, 0, ptrs), id));
    ctx.seen.delete(id);
  };

  // Current frame first, then outer frames.
  for (let f = step.stack.length - 1; f >= 0; f--) {
    const frame = step.stack[f];
    const pointerFrame = framePointerVars(frame);
    for (const [name, v] of frame.vars) {
      if (v.k === 'ref') {
        addObject(v.id);
      } else if (v.k === 'str' && v.s !== undefined && v.s.length > 1 && pointerFrame && f === ctx.top) {
        // Strings walked by index pointers render as character arrays.
        const chars = [...v.s].map((ch) => ({ k: 'str', r: JSON.stringify(ch), s: ch }));
        const ptrs = pointerMap(chars.length, [f], ctx);
        cards.push(card([{ name, current: true }], `str, ${plural(chars.length, 'char')}`, renderArray(null, chars, chars.length, ctx, 0, ptrs)));
      }
    }
  }
  if ((step.event === 'return' || step.event === 'yield') && step.ret && step.ret.k === 'ref') addObject(step.ret.id, 'return value');
  // Structures only reachable through other objects (e.g. a list of linked lists).
  chains.forEach((c, i) => { if (!done.has(`L${i}`)) addObject(c.nodes[0]); });
  trees.forEach((t) => { if (!done.has(`T${t.root}`)) addObject(t.root); });

  return cards.join('') || '<p class="hint">Lists, dicts, sets, strings with pointers, linked lists, trees and objects appear here as your code creates them.</p>';
}

// ---------------------------------------------------------------------------
// Share links and saved drafts
// ---------------------------------------------------------------------------

function toB64Url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function encodeShare(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  if ('CompressionStream' in window) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return `z${toB64Url(new Uint8Array(await new Response(stream).arrayBuffer()))}`;
  }
  return `p${toB64Url(bytes)}`;
}

async function decodeShare(hash) {
  const kind = hash[0];
  let bytes = fromB64Url(hash.slice(1));
  if (kind === 'z') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  } else if (kind !== 'p') {
    throw new Error('unknown link format');
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function copyShareLink() {
  const button = $('#share');
  try {
    const hash = await encodeShare({ l: state.lang, c: editor.getValue(), i: $('#stdin').value });
    const url = `${location.origin}${location.pathname}#${hash}`;
    history.replaceState(null, '', `#${hash}`);
    await navigator.clipboard.writeText(url);
    button.textContent = 'Link copied';
  } catch {
    button.textContent = 'Copy from the address bar';
  }
  setTimeout(() => { button.textContent = 'Copy link'; }, 2000);
}

function storage(action, key, value) {
  try {
    if (action === 'get') return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode); drafts are a convenience only.
  }
  return null;
}

function persist() {
  storage('set', `cv:code:${state.lang}`, editor.getValue());
  storage('set', `cv:stdin:${state.lang}`, $('#stdin').value);
  storage('set', 'cv:lang', state.lang);
}

function draftFor(lang) {
  const code = storage('get', `cv:code:${lang}`);
  if (code) return { c: code, i: storage('get', `cv:stdin:${lang}`) || '' };
  const ex = EXAMPLES[lang][0];
  return { c: ex.code, i: ex.stdin || '' };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let loading = false; // true while code is placed in the editor programmatically

function setEditor(code, stdin) {
  loading = true;
  editor.setValue(code);
  editor.clearHistory();
  loading = false;
  $('#stdin').value = stdin || '';
  $('#stdin-box').open = Boolean(stdin);
}

function fillExamples() {
  const select = $('#examples');
  select.length = 1;
  EXAMPLES[state.lang].forEach((ex, i) => select.add(new Option(ex.name, String(i))));
}

function setLanguage(lang, draft) {
  if (!LANGUAGES[lang]) lang = 'java';
  if (state.lang && state.lang !== lang) persist();
  state.lang = lang;
  stopPlaying();
  clearTimeout(state.autorunTimer);
  if (state.request) state.request.abort();
  state.pending = null;
  state.trace = null;
  for (const btn of document.querySelectorAll('[data-lang]')) btn.setAttribute('aria-checked', String(btn.dataset.lang === lang));
  editor.setOption('mode', LANGUAGES[lang].mode);
  const d = draft || draftFor(lang);
  setEditor(d.c, d.i);
  fillExamples();
  storage('set', 'cv:lang', lang);
  $('#frames').innerHTML = '';
  $('#objects').innerHTML = '';
  $('#stdout').textContent = '';
  render();
  run({ reset: true });
}

function loadExample(index) {
  const ex = EXAMPLES[state.lang][index];
  if (!ex) return;
  setEditor(ex.code, ex.stdin);
  persist();
  stopPlaying();
  run({ reset: true });
}

function bindHighlighting() {
  // Hovering a variable's chip highlights the matching drawing, and vice versa.
  const toggle = (event, on) => {
    const el = event.target.closest('[data-ref], [data-obj]');
    if (!el) return;
    const id = el.dataset.ref || el.dataset.obj;
    document.querySelectorAll(`[data-obj="${id}"], [data-ref="${id}"]`).forEach((x) => x.classList.toggle('hl', on));
  };
  for (const root of [$('#frames'), $('#objects')]) {
    root.addEventListener('mouseover', (e) => toggle(e, true));
    root.addEventListener('mouseout', (e) => toggle(e, false));
    root.addEventListener('focusin', (e) => toggle(e, true));
    root.addEventListener('focusout', (e) => toggle(e, false));
  }
}

async function init() {
  editor = CodeMirror.fromTextArea($('#code'), {
    mode: 'text/x-java',
    theme: 'board',
    lineNumbers: true,
    indentUnit: 4,
    tabSize: 4,
    matchBrackets: true,
    autoCloseBrackets: true,
    viewportMargin: Infinity,
    extraKeys: {
      Tab: (cm) => (cm.somethingSelected() ? cm.indentSelection('add') : cm.replaceSelection('    ')),
      'Shift-Tab': (cm) => cm.indentSelection('subtract'),
      'Ctrl-Enter': () => run({ reset: true }),
      'Cmd-Enter': () => run({ reset: true }),
    },
  });

  const select = $('#examples');
  select.addEventListener('change', () => {
    if (select.value !== '') loadExample(Number(select.value));
    select.value = '';
  });
  for (const btn of document.querySelectorAll('[data-lang]')) {
    btn.addEventListener('click', () => {
      if (btn.dataset.lang !== state.lang) setLanguage(btn.dataset.lang);
    });
  }

  editor.on('change', () => { if (!loading) scheduleAutorun(); });
  $('#stdin').addEventListener('input', scheduleAutorun);
  $('#run').addEventListener('click', () => run({ reset: true }));
  $('#share').addEventListener('click', copyShareLink);
  $('#first').addEventListener('click', () => setStep(0));
  $('#prev').addEventListener('click', () => setStep(state.step - 1));
  $('#next').addEventListener('click', () => setStep(state.step + 1));
  $('#last').addEventListener('click', () => setStep(Infinity));
  $('#play').addEventListener('click', togglePlay);
  $('#scrub').addEventListener('input', (e) => setStep(Number(e.target.value)));
  $('#speed').addEventListener('change', () => {
    if (state.playing) {
      stopPlaying();
      togglePlay();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('.CodeMirror, input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    const keys = {
      ArrowLeft: () => setStep(state.step - 1),
      ArrowRight: () => setStep(state.step + 1),
      Home: () => setStep(0),
      End: () => setStep(Infinity),
      ' ': togglePlay,
    };
    if (keys[e.key]) {
      e.preventDefault();
      keys[e.key]();
    }
  });

  bindHighlighting();

  let shared = null;
  if (location.hash.length > 1) {
    try {
      shared = await decodeShare(location.hash.slice(1));
    } catch {
      shared = null;
    }
  }
  if (shared) {
    state.lang = '';
    setLanguage(shared.l || 'python', { c: shared.c || '', i: shared.i || '' });
  } else {
    state.lang = '';
    setLanguage(storage('get', 'cv:lang') || 'java');
  }
}

init();
