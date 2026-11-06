import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeEditor from './components/CodeEditor.jsx';
import Header from './components/Header.jsx';
import StepControls from './components/StepControls.jsx';
import CallStack from './components/CallStack.jsx';
import DataPanel from './components/DataPanel.jsx';
import { VizContext } from './components/Values.jsx';
import { EXAMPLES, LANGUAGES } from './lib/examples.js';
import { Runner } from './lib/runner.js';
import { encodeShare, load, save, saveDraft, draftFor } from './lib/share.js';
import { collectRefs, describeStep } from './lib/trace.js';

const AUTORUN_DELAY_MS = { python: 700, server: 1200 };

/** `initial` is { lang, code, stdin } from a share link or saved draft. */
export default function App({ initial }) {
  const [lang, setLang] = useState(initial.lang);
  const [stdin, setStdin] = useState(initial.stdin);
  const [stdinOpen, setStdinOpen] = useState(Boolean(initial.stdin));
  const [trace, setTrace] = useState(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(600);
  const [autorun, setAutorun] = useState(load('cv:autorun') !== 'off');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null); // { text, kind } shown until the next trace arrives
  const [hovered, setHovered] = useState(null);

  const editor = useRef(null);
  const consoleRef = useRef(null);
  const autorunTimer = useRef(null);
  // Latest values for callbacks that outlive a render (timers, the runner, key handlers).
  const latest = useRef({});
  latest.current = { lang, stdin, autorun, total: trace ? trace.steps.length : 0 };

  const runner = useMemo(() => new Runner({
    onTrace: (t, reset) => {
      setTrace(t);
      setNotice(null);
      setStep((s) => (reset ? 0 : Math.min(s, Math.max(0, t.steps.length - 1))));
      if (!t.steps.length) setPlaying(false);
    },
    onNotice: (text, kind = '') => setNotice({ text, kind }),
    onBusy: setBusy,
  }), []);

  const run = useCallback((opts = {}) => {
    clearTimeout(autorunTimer.current);
    const { lang: l, stdin: input } = latest.current;
    runner.run({
      lang: opts.lang || l,
      code: opts.code ?? editor.current.getCode(),
      stdin: opts.stdin ?? input,
      reset: Boolean(opts.reset),
    });
  }, [runner]);

  // First run once the editor exists.
  useEffect(() => { run({ reset: true }); }, [run]);

  const scheduleAutorun = useCallback(() => {
    const { lang: l, stdin: input, autorun: on } = latest.current;
    saveDraft(l, editor.current.getCode(), input);
    if (!on) return;
    clearTimeout(autorunTimer.current);
    const delay = LANGUAGES[l].server ? AUTORUN_DELAY_MS.server : AUTORUN_DELAY_MS.python;
    autorunTimer.current = setTimeout(() => run(), delay);
  }, [run]);

  function loadCode(code, input, nextLang = lang) {
    setPlaying(false);
    editor.current.setCode(code);
    setStdin(input || '');
    setStdinOpen(Boolean(input));
    saveDraft(nextLang, code, input || '');
    run({ lang: nextLang, code, stdin: input || '', reset: true });
  }

  function switchLanguage(next) {
    saveDraft(lang, editor.current.getCode(), stdin);
    runner.cancel();
    setTrace(null);
    setStep(0);
    setLang(next);
    const draft = draftFor(next);
    loadCode(draft.code, draft.stdin, next);
  }

  async function share() {
    try {
      const hash = await encodeShare({ l: lang, c: editor.current.getCode(), i: stdin });
      history.replaceState(null, '', `#${hash}`);
      await navigator.clipboard.writeText(`${location.origin}${location.pathname}#${hash}`);
      return true;
    } catch {
      return false;
    }
  }

  // ---- stepping ---------------------------------------------------------

  const total = trace ? trace.steps.length : 0;
  const goTo = useCallback((i) => {
    const n = latest.current.total;
    if (n) setStep(Math.max(0, Math.min(n - 1, i)));
  }, []);

  // Relative moves use the latest step, so quick repeated clicks are never lost.
  const move = useCallback((delta) => {
    setStep((s) => Math.max(0, Math.min(Math.max(0, latest.current.total - 1), s + delta)));
  }, []);

  const togglePlay = useCallback(() => {
    setPlaying((p) => {
      if (p) return false;
      if (latest.current.total < 2) return false;
      setStep((s) => (s >= latest.current.total - 1 ? 0 : s));
      return true;
    });
  }, []);

  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(() => {
      setStep((s) => {
        if (s >= latest.current.total - 1) {
          setPlaying(false);
          return s;
        }
        return s + 1;
      });
    }, speed);
    return () => clearInterval(timer);
  }, [playing, speed]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest('.cm-editor, input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
      const actions = {
        ArrowLeft: () => move(-1),
        ArrowRight: () => move(1),
        Home: () => goTo(0),
        End: () => goTo(latest.current.total - 1),
        ' ': togglePlay,
      };
      if (actions[e.key]) {
        e.preventDefault();
        actions[e.key]();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [goTo, move, togglePlay]);

  // ---- what to show for the current step ----------------------------------

  const current = trace && trace.steps[step];
  const prevStep = trace && step > 0 ? trace.steps[step - 1] : null;
  const isLast = trace && step === total - 1;

  const marks = useMemo(() => {
    if (!trace) return { current: null };
    if (!current) return { current: trace.line, error: true }; // compile/syntax error: nothing ran
    return {
      current: current.line,
      previous: prevStep && prevStep.event !== 'done' ? prevStep.line : null,
      error: current.event === 'exception' || current.event === 'error',
    };
  }, [trace, current, prevStep]);

  let status;
  if (notice) status = [notice.text, notice.kind];
  else if (!trace) status = ['Getting ready…', ''];
  else if (!current) status = [`${trace.error}${trace.line ? ` (line ${trace.line})` : ''}`, 'error'];
  else if (trace.limit && isLast) status = [trace.error, 'error'];
  else status = describeStep(current, trace);

  const stdout = !current ? '' : isLast ? trace.stdout : trace.stdout.slice(0, current.out);
  useEffect(() => {
    if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [stdout]);

  const viz = useMemo(() => current && {
    heap: current.heap,
    prevHeap: prevStep ? prevStep.heap : null,
    stack: current.stack,
    top: current.stack.length - 1,
    refs: collectRefs(current.stack),
    nil: LANGUAGES[lang].nil,
  }, [current, prevStep, lang]);

  return (
    <>
      <Header
        lang={lang}
        busy={busy}
        autorun={autorun}
        onLanguage={switchLanguage}
        onExample={(i) => loadCode(EXAMPLES[lang][i].code, EXAMPLES[lang][i].stdin)}
        onAutorun={(on) => { setAutorun(on); save('cv:autorun', on ? 'on' : 'off'); }}
        onRun={() => run({ reset: true })}
        onShare={share}
      />
      <main className="layout">
        <section className="code-side" aria-label="Code">
          <CodeEditor ref={editor} initialCode={initial.code} lang={lang} marks={marks}
            onChange={scheduleAutorun} onRun={() => run({ reset: true })} />
          <details className="stdin-box" open={stdinOpen} onToggle={(e) => setStdinOpen(e.currentTarget.open)}>
            <summary>Program input</summary>
            <textarea rows={4} spellCheck={false} value={stdin} aria-label="Program input"
              placeholder="Text your program reads with Scanner, cin or input(), like HackerRank's stdin"
              onChange={(e) => { setStdin(e.target.value); latest.current.stdin = e.target.value; scheduleAutorun(); }} />
          </details>
          <div className="console">
            <h2>Output</h2>
            <pre ref={consoleRef}>{stdout}</pre>
          </div>
        </section>

        <section className="viz-side" aria-label="Visualization">
          <StepControls step={step} total={total} playing={playing} speed={speed}
            onStep={goTo} onMove={move} onTogglePlay={togglePlay} onSpeed={setSpeed} />
          <p className={status[1] ? `status is-${status[1]}` : 'status'} role="status">{status[0]}</p>
          <div className="viz">
            <div className="stack-col">
              <h2>Call stack</h2>
              {current && (
                <VizContext.Provider value={{ ...viz, hovered, setHovered }}>
                  <CallStack step={current} prevStep={prevStep} />
                </VizContext.Provider>
              )}
            </div>
            <div className="data-col">
              <h2>Data</h2>
              {current && (
                <VizContext.Provider value={{ ...viz, hovered, setHovered }}>
                  <DataPanel step={current} />
                </VizContext.Provider>
              )}
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
