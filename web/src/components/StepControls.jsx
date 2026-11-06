export const SPEEDS = [
  { label: 'Slow', ms: 1200 },
  { label: 'Normal', ms: 600 },
  { label: 'Fast', ms: 250 },
  { label: 'Very fast', ms: 60 },
];

/** First / Back / Play / Next / Last, a scrubber, the step counter and playback speed. */
export default function StepControls({ step, total, playing, speed, onStep, onMove, onTogglePlay, onSpeed }) {
  const none = total === 0;
  const atStart = none || step === 0;
  const atEnd = none || step >= total - 1;
  return (
    <div className="controls" role="toolbar" aria-label="Step controls">
      <button type="button" title="First step (Home)" aria-label="First step" disabled={atStart} onClick={() => onStep(0)}>⏮</button>
      <button type="button" title="Previous step (←)" disabled={atStart} onClick={() => onMove(-1)}>‹ Back</button>
      <button type="button" className="play" title="Play / pause (Space)" disabled={total < 2} onClick={onTogglePlay}>
        {playing ? 'Pause' : 'Play'}
      </button>
      <button type="button" title="Next step (→)" disabled={atEnd} onClick={() => onMove(1)}>Next ›</button>
      <button type="button" title="Last step (End)" aria-label="Last step" disabled={atEnd} onClick={() => onStep(total - 1)}>⏭</button>
      <input type="range" className="scrub" min={0} max={Math.max(0, total - 1)} value={step} aria-label="Step"
        onChange={(e) => onStep(Number(e.target.value))} />
      <span className="counter">{none ? '0 / 0' : `${step + 1} / ${total}`}</span>
      <label className="sr-only" htmlFor="speed">Playback speed</label>
      <select id="speed" value={speed} onChange={(e) => onSpeed(Number(e.target.value))}>
        {SPEEDS.map((s) => <option key={s.ms} value={s.ms}>{s.label}</option>)}
      </select>
    </div>
  );
}
