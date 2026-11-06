import { Fragment } from 'react';
import {
  attr, buildChains, buildTrees, cellText, childRef, framePointerVars, isListNode, isTreeNode,
  namesFor, nodeVal, plural, pointerMap, refLabel, sig, typeLabel,
} from '../lib/trace.js';
import { ArrayView, Body, PtrLabels, Value, useHover, useViz } from './Values.jsx';

const cx = (...names) => names.filter(Boolean).join(' ');

function Card({ names, type, objId, children }) {
  const { hl, handlers } = useHover(objId);
  return (
    <figure className={cx('card', hl && 'hl')} {...handlers}>
      <figcaption>
        <span className="names">
          {names.map((n, i) => (
            <Fragment key={n.name}>
              {i > 0 && ', '}
              <span className={n.current ? 'name' : 'name faded'}>{n.name}</span>
            </Fragment>
          ))}
        </span>
        <span className="type">{type}</span>
      </figcaption>
      {children}
    </figure>
  );
}

function ListNodeBox({ id }) {
  const ctx = useViz();
  const { hl, handlers } = useHover(id);
  const o = ctx.heap[id];
  const prev = ctx.prevHeap && ctx.prevHeap[id];
  const changed = prev && (sig(attr(prev, 'next')) !== sig(attr(o, 'next')) || sig(nodeVal(prev)) !== sig(nodeVal(o)));
  const names = namesFor(id, ctx);
  const val = nodeVal(o);
  return (
    <div className={cx('ll-node', names.some((n) => n.current) && 'pointed', hl && 'hl')} {...handlers}>
      <PtrLabels list={names} />
      <div className={cx('node-box', changed && 'changed')}>
        <span className="node-val">{val ? <Value v={val} depth={1} seen={new Set()} /> : o.cls}</span>
        <span className="node-next" aria-hidden="true" />
      </div>
    </div>
  );
}

function LinkedList({ chain }) {
  const { heap, nil } = useViz();
  const { end } = chain;
  let tail;
  if (end.kind === 'cycle') tail = <span className="ll-end cycle">back to {cellText(nodeVal(heap[end.id]) || { r: '?' })}</span>;
  else if (end.kind === 'joins') tail = <span className="ll-end">joins {refLabel(end.id, heap)}</span>;
  else if (end.kind === 'more') tail = <span className="ll-end">…</span>;
  else if (end.kind === 'value') tail = <span className="ll-end"><Value v={end.v} depth={1} seen={new Set()} /></span>;
  else tail = <span className="ll-end none">{nil}</span>;
  return (
    <div className="ll">
      {chain.nodes.map((id) => (
        <Fragment key={id}>
          <ListNodeBox id={id} />
          <span className="ll-arrow" aria-hidden="true">→</span>
        </Fragment>
      ))}
      {tail}
    </div>
  );
}

function TreeNodeMark({ id, p, X, Y }) {
  const ctx = useViz();
  const { hl, handlers } = useHover(id);
  const o = ctx.heap[id];
  const prev = ctx.prevHeap && ctx.prevHeap[id];
  const changed = prev && ['left', 'right', 'val'].some((k) => sig(attr(prev, k)) !== sig(attr(o, k)));
  const names = namesFor(id, ctx);
  const val = nodeVal(o);
  let text = val ? cellText(val) : '?';
  if (text.length > 4) text = `${text.slice(0, 3)}…`;
  const cls = cx('tnode', names.some((n) => n.current) && 'pointed',
    names.length && !names.some((n) => n.current) && 'pointed-faded', changed && 'changed', hl && 'hl');
  return (
    <g className={cls} {...handlers}>
      <circle cx={X(p)} cy={Y(p)} r={17} />
      <text className="tval" x={X(p)} y={Y(p) + 5}>{text}</text>
      {names.length > 0 && <text className="tlabel" x={X(p)} y={Y(p) + 33}>{names.map((n) => n.name).join(', ')}</text>}
    </g>
  );
}

function Tree({ tree }) {
  const { heap } = useViz();
  const X = (p) => 26 + p.x * 46;
  const Y = (p) => 24 + p.d * 66;
  const width = 52 + Math.max(0, tree.count - 1) * 46;
  const height = 24 + tree.maxDepth * 66 + 44;
  const edges = [];
  for (const [id, p] of tree.pos) {
    for (const side of ['left', 'right']) {
      const c = childRef(heap, heap[id], side, isTreeNode);
      const cp = c != null && tree.pos.get(c);
      if (cp) edges.push(<line key={`${id}${side}`} x1={X(p)} y1={Y(p)} x2={X(cp)} y2={Y(cp)} />);
    }
  }
  return (
    <div className="tree-wrap">
      <svg className="tree" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Binary tree">
        {edges}
        {[...tree.pos].map(([id, p]) => <TreeNodeMark key={id} id={id} p={p} X={X} Y={Y} />)}
      </svg>
      {tree.truncated && <p className="legend">Large tree: showing the first 127 nodes.</p>}
    </div>
  );
}

/** The Data column: one card per array, map, string, linked list, tree or object in scope. */
export default function DataPanel({ step }) {
  const ctx = useViz();
  const { heap, refs, top } = ctx;
  const { chains, chainOf } = buildChains(heap);
  const { trees, rootOf } = buildTrees(heap);
  const done = new Set();
  const cards = [];

  const addObject = (id, fallbackName) => {
    const o = heap[id];
    if (!o) return;
    const named = (list) => (list.length ? list : [{ name: fallbackName || 'value', current: false }]);
    if (isListNode(o)) {
      const c = chainOf.get(id);
      if (c == null || done.has(`L${c}`)) return;
      done.add(`L${c}`);
      cards.push(
        <Card key={`L${c}`} names={named(namesFor(chains[c].nodes[0], ctx))} type="linked list">
          <LinkedList chain={chains[c]} />
        </Card>,
      );
      return;
    }
    if (isTreeNode(o)) {
      const r = rootOf.get(id);
      const tree = trees.find((x) => x.root === r);
      if (!tree || done.has(`T${r}`)) return;
      done.add(`T${r}`);
      cards.push(<Card key={`T${r}`} names={named(namesFor(r, ctx))} type="binary tree"><Tree tree={tree} /></Card>);
      return;
    }
    if (['func', 'class', 'other'].includes(o.t) || done.has(`O${id}`)) return;
    if (o.t === 'obj' && !o.attrs.length) return;
    done.add(`O${id}`);
    let ptrs = null;
    if (['list', 'tuple', 'deque'].includes(o.t)) {
      ptrs = pointerMap(o.len, new Set([top, ...(refs.get(id) || []).map((r) => r.frame)]), ctx);
    }
    cards.push(
      <Card key={`O${id}`} names={named(namesFor(id, ctx))} type={typeLabel(o)} objId={id}>
        <Body id={id} o={o} depth={0} seen={new Set([id])} ptrs={ptrs} />
      </Card>,
    );
  };

  // Current frame first, then outer frames.
  for (let f = step.stack.length - 1; f >= 0; f--) {
    const frame = step.stack[f];
    const pointerFrame = framePointerVars(frame);
    for (const [name, v] of frame.vars) {
      if (v.k === 'ref') {
        addObject(v.id);
      } else if (v.k === 'str' && v.s !== undefined && v.s.length > 1 && pointerFrame && f === top) {
        // Strings walked by index pointers are drawn as character arrays.
        const chars = [...v.s].map((ch) => ({ k: 'str', r: JSON.stringify(ch), s: ch }));
        cards.push(
          <Card key={`S${name}`} names={[{ name, current: true }]} type={`string, ${plural(chars.length, 'char')}`}>
            <ArrayView id={null} items={chars} len={chars.length} depth={0} seen={new Set()} ptrs={pointerMap(chars.length, [f], ctx)} />
          </Card>,
        );
      }
    }
  }
  if ((step.event === 'return' || step.event === 'yield') && step.ret && step.ret.k === 'ref') addObject(step.ret.id, 'return value');
  // Structures only reachable through other objects (e.g. a list of linked lists).
  chains.forEach((c, i) => { if (!done.has(`L${i}`)) addObject(c.nodes[0]); });
  trees.forEach((t) => { if (!done.has(`T${t.root}`)) addObject(t.root); });

  if (!cards.length) {
    return <p className="hint">Arrays, maps, sets, strings with pointers, linked lists, trees and objects appear here as your code creates them.</p>;
  }
  return cards;
}
