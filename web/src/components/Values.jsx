import { createContext, useContext } from 'react';
import { cellText, colorIndex, isGrid, isNode, refLabel, sig } from '../lib/trace.js';

/**
 * Shared by everything that draws a step: the heap, the previous step's heap (to mark
 * changes), the stack, which object is hovered, and the language's word for null.
 */
export const VizContext = createContext(null);
export const useViz = () => useContext(VizContext);

/** Props that make an element highlight together with every other view of the same object. */
export function useHover(id) {
  const { hovered, setHovered } = useViz();
  return {
    hl: id != null && hovered === id,
    handlers: id == null ? {} : {
      onMouseEnter: () => setHovered(id),
      onMouseLeave: () => setHovered(null),
      onFocus: () => setHovered(id),
      onBlur: () => setHovered(null),
    },
  };
}

const cx = (...names) => names.filter(Boolean).join(' ');

export function Chip({ id }) {
  const { heap } = useViz();
  const { hl, handlers } = useHover(id);
  return <span className={cx('chip', hl && 'hl')} tabIndex={0} {...handlers}>{refLabel(id, heap)}</span>;
}

export function Prim({ v, bare = false }) {
  return <span className={`v v-${v.k}`}>{bare ? cellText(v) : v.r}</span>;
}

/** A value inside a drawing: plain values as text, containers drawn inline, nodes/objects as chips. */
export function Value({ v, depth, seen }) {
  const { heap } = useViz();
  if (!v) return null;
  if (v.k !== 'ref') return <Prim v={v} bare={depth > 0} />;
  const o = heap[v.id];
  if (!o || depth >= 3 || seen.has(v.id) || isNode(o) || o.t === 'obj') return <Chip id={v.id} />;
  return <Nested id={v.id} o={o} depth={depth} seen={seen} />;
}

function Nested({ id, o, depth, seen }) {
  const { hl, handlers } = useHover(id);
  const inner = new Set(seen).add(id);
  return (
    <div className={cx('nested', hl && 'hl')} {...handlers}>
      <Body id={id} o={o} depth={depth} seen={inner} />
    </div>
  );
}

export function Body({ id, o, depth, seen, ptrs = null }) {
  const { heap } = useViz();
  switch (o.t) {
    case 'list':
    case 'tuple':
    case 'deque':
      if (depth === 0 && isGrid(o, heap)) return <GridView id={id} o={o} />;
      return <ArrayView id={id} items={o.items} len={o.len} depth={depth} seen={seen} ptrs={ptrs} />;
    case 'dict': return <DictView id={id} o={o} depth={depth} seen={seen} />;
    case 'set': return <SetView id={id} o={o} depth={depth} seen={seen} />;
    case 'obj': return <AttrsView id={id} o={o} depth={depth} seen={seen} />;
    default: return <span className="v v-other">{o.r || o.cls}</span>;
  }
}

export function PtrLabels({ list }) {
  return (
    <div className="ptrs">
      {list.map((p) => (
        <span key={p.name} className={cx('ptr', `c${colorIndex(p.name)}`, !p.current && 'faded')}>{p.name}</span>
      ))}
    </div>
  );
}

export function ArrayView({ id, items, len, depth, seen, ptrs }) {
  const { prevHeap } = useViz();
  const prev = id != null && prevHeap ? prevHeap[id] : null;
  const prevItems = prev && prev.items;
  const showPtrs = Boolean(ptrs && ptrs.size);
  if (!items.length && !(showPtrs && ptrs.get(len))) return <span className="empty">empty</span>;
  const endPtr = showPtrs && ptrs.get(len);
  return (
    <div className="arr">
      {items.map((v, i) => {
        const changed = prevItems && (i >= prevItems.length || sig(prevItems[i]) !== sig(v));
        const p = (showPtrs && ptrs.get(i)) || [];
        return (
          <div key={i} className={cx('slot', p.length && 'pointed')}>
            {showPtrs && <PtrLabels list={p} />}
            <div className={cx('cell', changed && 'changed')}><Value v={v} depth={depth + 1} seen={seen} /></div>
            <div className="idx">{i}</div>
          </div>
        );
      })}
      {len > items.length && <div className="slot more"><div className="cell">+{len - items.length}</div></div>}
      {endPtr && len <= items.length && (
        <div className="slot pointed end"><PtrLabels list={endPtr} /><div className="cell" /><div className="idx">{len}</div></div>
      )}
    </div>
  );
}

export function GridView({ id, o }) {
  const { heap, prevHeap, stack, top, refs } = useViz();
  const rows = o.items.map((v) => heap[v.id]);
  const cols = Math.max(...rows.map((r) => r.items.length));
  const marks = new Map();
  for (const f of new Set([top, ...(refs.get(id) || []).map((r) => r.frame)])) {
    const vars = new Map((stack[f] ? stack[f].vars : []).map(([n, v]) => [n, v]));
    for (const [a, b] of [['r', 'c'], ['row', 'col'], ['i', 'j'], ['nr', 'nc'], ['x', 'y']]) {
      const r = vars.get(a);
      const c = vars.get(b);
      if (!r || !c || r.n === undefined || c.n === undefined) continue;
      if (r.n < 0 || r.n >= rows.length || c.n < 0 || c.n >= cols) continue;
      const key = `${r.n},${c.n}`;
      if (!marks.has(key)) marks.set(key, []);
      marks.get(key).push({ name: `${a},${b}`, current: f === top });
    }
  }
  const legend = [...new Set([...marks.values()].flat().map((m) => m.name))];
  return (
    <>
      <table className="grid">
        <thead>
          <tr><th />{Array.from({ length: cols }, (_, c) => <th key={c} scope="col">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, r) => {
            const prevRow = prevHeap && prevHeap[id] && prevHeap[o.items[r].id];
            return (
              <tr key={r}>
                <th scope="row">{r}</th>
                {row.items.map((v, c) => {
                  const changed = prevRow && sig(prevRow.items[c]) !== sig(v);
                  const m = marks.get(`${r},${c}`);
                  return (
                    <td key={c} title={m ? m.map((x) => x.name).join(' / ') : undefined}
                      className={cx(changed && 'changed', m && 'pointed', m && !m.some((x) => x.current) && 'faded')}>
                      <Prim v={v} bare />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {legend.length > 0 && <p className="legend">Outlined: cell at ({legend.join('), (')})</p>}
    </>
  );
}

export function DictView({ id, o, depth, seen }) {
  const { prevHeap } = useViz();
  if (!o.entries.length) return <span className="empty">empty</span>;
  const prev = prevHeap && prevHeap[id];
  const before = prev && prev.entries ? new Map(prev.entries.map(([k, v]) => [sig(k), sig(v)])) : null;
  return (
    <table className="kv">
      <tbody>
        {o.entries.map(([k, v], i) => (
          <tr key={i} className={before && before.get(sig(k)) !== sig(v) ? 'changed' : undefined}>
            <td className="key"><Value v={k} depth={depth + 1} seen={seen} /></td>
            <td><Value v={v} depth={depth + 1} seen={seen} /></td>
          </tr>
        ))}
        {o.len > o.entries.length && <tr><td colSpan={2} className="empty">+{o.len - o.entries.length} more</td></tr>}
      </tbody>
    </table>
  );
}

export function SetView({ id, o, depth, seen }) {
  const { prevHeap } = useViz();
  if (!o.items.length) return <span className="empty">empty</span>;
  const prev = prevHeap && prevHeap[id];
  const before = prev && prev.items ? new Set(prev.items.map(sig)) : null;
  return (
    <div className="set">
      {o.items.map((v, i) => (
        <span key={i} className={cx('set-item', before && !before.has(sig(v)) && 'changed')}>
          <Value v={v} depth={depth + 1} seen={seen} />
        </span>
      ))}
      {o.len > o.items.length && <span className="empty">+{o.len - o.items.length}</span>}
    </div>
  );
}

export function AttrsView({ id, o, depth, seen }) {
  const { heap, prevHeap } = useViz();
  if (!o.attrs.length) return <span className="empty">{o.cls} with no attributes</span>;
  const prev = prevHeap && prevHeap[id];
  const before = prev && prev.attrs ? new Map(prev.attrs.map(([k, v]) => [k, sig(v)])) : null;
  return (
    <table className="kv attrs">
      <tbody>
        {o.attrs.map(([k, v]) => {
          // Attributes holding containers are drawn inline, one level deep.
          const ref = v.k === 'ref' && heap[v.id];
          const inline = ref && !isNode(ref) && ref.t !== 'obj' && depth < 2 && !seen.has(v.id);
          return (
            <tr key={k} className={before && before.get(k) !== sig(v) ? 'changed' : undefined}>
              <th scope="row">.{k}</th>
              <td>{inline ? <Nested id={v.id} o={ref} depth={depth + 1} seen={seen} /> : <Value v={v} depth={depth + 1} seen={seen} />}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
