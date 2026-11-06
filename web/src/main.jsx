import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { LANGUAGES } from './lib/examples.js';
import { decodeShare, draftFor, load } from './lib/share.js';
import { applyTheme, resolveTheme } from './lib/themes.js';
import './styles.css';

/** Start from a share link if there is one, otherwise the last language and its draft. */
async function initialState() {
  if (location.hash.length > 1) {
    try {
      const shared = await decodeShare(location.hash.slice(1));
      const lang = LANGUAGES[shared.l] ? shared.l : 'python';
      return { lang, code: shared.c || '', stdin: shared.i || '' };
    } catch {
      // Broken link: fall through to the saved draft.
    }
  }
  const saved = load('cv:lang');
  const lang = LANGUAGES[saved] ? saved : 'java';
  return { lang, ...draftFor(lang) };
}

// Set the theme before the first paint so the page doesn't flash.
applyTheme(resolveTheme(load('cv:theme') || 'system'));

initialState().then((initial) => {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App initial={initial} />
    </StrictMode>,
  );
});
