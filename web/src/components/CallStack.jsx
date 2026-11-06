import { frameLabel, sig } from '../lib/trace.js';
import { Chip, Prim } from './Values.jsx';

function VarValue({ v }) {
  if (!v) return null;
  return v.k === 'ref' ? <Chip id={v.id} /> : <Prim v={v} />;
}

/** Frames, current call on top; variables that just changed are highlighted. */
export default function CallStack({ step, prevStep }) {
  const frames = [];
  for (let f = step.stack.length - 1; f >= 0; f--) {
    const frame = step.stack[f];
    const isTop = f === step.stack.length - 1;
    const prevFrame = prevStep && prevStep.stack[f] && prevStep.stack[f].name === frame.name ? prevStep.stack[f] : null;
    const before = prevFrame ? new Map(prevFrame.vars.map(([n, v]) => [n, sig(v)])) : null;
    const returns = isTop && (step.event === 'return' || step.event === 'yield');
    frames.push(
      <section key={f} className={isTop ? 'frame current' : 'frame'}>
        <h3>
          {frameLabel(frame.name)}
          {frame.line && !isTop ? <span className="at">line {frame.line}</span> : null}
        </h3>
        {frame.vars.length ? (
          <table className="vars">
            <tbody>
              {frame.vars.map(([name, v]) => (
                <tr key={name} className={before && before.get(name) !== sig(v) ? 'changed' : undefined}>
                  <th scope="row">{name}</th>
                  <td><VarValue v={v} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="none">No variables yet</p>}
        {returns && (
          <div className="ret">{step.event === 'yield' ? 'yields' : 'returns'} {step.ret ? <VarValue v={step.ret} /> : null}</div>
        )}
      </section>,
    );
  }
  return frames;
}
