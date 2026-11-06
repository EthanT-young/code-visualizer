import { useState } from 'react';
import { EXAMPLES, LANGUAGES } from '../lib/examples.js';
import { THEMES } from '../lib/themes.js';

/** Title, language switch, example picker, theme, run-as-you-type toggle, Run and Copy link. */
export default function Header({ lang, busy, autorun, themeChoice, onTheme, onLanguage, onExample, onAutorun, onRun, onShare }) {
  const [shareLabel, setShareLabel] = useState('Copy link');

  async function share() {
    setShareLabel(await onShare() ? 'Link copied' : 'Copy from the address bar');
    setTimeout(() => setShareLabel('Copy link'), 2000);
  }

  return (
    <header className="bar">
      <div className="title">
        <h1>Code Visualizer</h1>
        <div className="langs" role="radiogroup" aria-label="Language">
          {Object.entries(LANGUAGES).map(([key, { label }]) => (
            <button key={key} type="button" role="radio" aria-checked={key === lang} onClick={() => key !== lang && onLanguage(key)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="bar-actions">
        <label className="sr-only" htmlFor="examples">Load an example</label>
        <select id="examples" value="" onChange={(e) => e.target.value !== '' && onExample(Number(e.target.value))}>
          <option value="">Load an example…</option>
          {EXAMPLES[lang].map((ex, i) => <option key={ex.name} value={i}>{ex.name}</option>)}
        </select>
        <label className="sr-only" htmlFor="theme">Theme</label>
        <select id="theme" value={themeChoice} onChange={(e) => onTheme(e.target.value)} title="Theme">
          {THEMES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <label className="toggle">
          <input type="checkbox" checked={autorun} onChange={(e) => onAutorun(e.target.checked)} /> Run as I type
        </label>
        <button type="button" className="primary" onClick={onRun}>{busy ? 'Running…' : 'Run'}</button>
        <button type="button" onClick={share}>{shareLabel}</button>
      </div>
    </header>
  );
}
