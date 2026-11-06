// Page themes. "Match system" follows the computer's light/dark setting with the VS Code themes.
export const THEMES = [
  { id: 'system', label: 'Match system' },
  { id: 'vscode-dark', label: 'VS Code Dark' },
  { id: 'vscode-light', label: 'VS Code Light' },
  { id: 'leetcode-dark', label: 'LeetCode Dark' },
  { id: 'chalkboard', label: 'Chalkboard' },
  { id: 'whiteboard', label: 'Whiteboard' },
];

const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)');

/** The concrete theme to show for a choice ("system" becomes a VS Code theme). */
export function resolveTheme(choice) {
  if (THEMES.some((t) => t.id === choice) && choice !== 'system') return choice;
  return darkQuery().matches ? 'vscode-dark' : 'vscode-light';
}

export function applyTheme(resolved) {
  document.documentElement.dataset.theme = resolved;
}

/** Calls back when the system light/dark setting changes. Returns an unsubscribe function. */
export function onSystemThemeChange(callback) {
  const q = darkQuery();
  q.addEventListener('change', callback);
  return () => q.removeEventListener('change', callback);
}
