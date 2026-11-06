// Monaco (VS Code's editor) with only what this site needs: the core editor plus
// Java, C++ and Python, highlighted with VS Code's Light+ / Dark+ colors.
// Core editor plus only the features you'd use while solving problems
// (the full build adds about 160 KB gzipped of IDE features with no use here).
import 'monaco-editor/esm/vs/editor/browser/coreCommands.js';
import 'monaco-editor/esm/vs/editor/browser/widget/codeEditor/codeEditorWidget.js';
import 'monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/esm/vs/editor/contrib/caretOperations/browser/caretOperations.js';
import 'monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/esm/vs/editor/contrib/comment/browser/comment.js';
import 'monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu.js';
import 'monaco-editor/esm/vs/editor/contrib/cursorUndo/browser/cursorUndo.js';
import 'monaco-editor/esm/vs/editor/contrib/dnd/browser/dnd.js';
import 'monaco-editor/esm/vs/editor/contrib/find/browser/findController.js';
import 'monaco-editor/esm/vs/editor/contrib/indentation/browser/indentation.js';
import 'monaco-editor/esm/vs/editor/contrib/lineSelection/browser/lineSelection.js';
import 'monaco-editor/esm/vs/editor/contrib/linesOperations/browser/linesOperations.js';
import 'monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor.js';
import 'monaco-editor/esm/vs/editor/contrib/smartSelect/browser/smartSelect.js';
import 'monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/esm/vs/editor/contrib/tokenization/browser/tokenization.js';
import 'monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter.js';
import 'monaco-editor/esm/vs/editor/contrib/wordOperations/browser/wordOperations.js';
import 'monaco-editor/esm/vs/editor/contrib/wordPartOperations/browser/wordPartOperations.js';
import 'monaco-editor/esm/vs/editor/common/standaloneStrings.js';
import 'monaco-editor/esm/vs/base/browser/ui/codicons/codiconStyles.js';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import * as javaDef from 'monaco-editor/esm/vs/basic-languages/java/java.js';
import * as cppDef from 'monaco-editor/esm/vs/basic-languages/cpp/cpp.js';
import * as pythonDef from 'monaco-editor/esm/vs/basic-languages/python/python.js';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

// ---- highlighting closer to VS Code ------------------------------------------
// Monaco's built-in highlighters color every keyword the same and don't recognize
// function or type names. VS Code shows control flow (if/for/return) in purple,
// functions in yellow and types in teal, so the identifier rule is replaced with one
// that sorts words into those groups.

const EXTRA = {
  java: {
    controlKeywords: ['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
      'return', 'try', 'catch', 'finally', 'throw', 'yield', 'import', 'package'],
    types: [],
  },
  cpp: {
    controlKeywords: ['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
      'return', 'try', 'catch', 'throw', 'goto', 'co_return', 'co_yield', 'co_await'],
    types: ['std', 'vector', 'string', 'map', 'unordered_map', 'set', 'unordered_set', 'multiset', 'multimap',
      'stack', 'queue', 'deque', 'priority_queue', 'pair', 'tuple', 'list', 'array', 'bitset', 'optional',
      'size_t', 'greater', 'less', 'function', 'string_view'],
  },
  python: {
    // Python's built-in list mixes keywords with builtins; use the real keywords.
    keywords: ['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
      'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
      'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'self', 'cls'],
    controlKeywords: ['if', 'elif', 'else', 'for', 'while', 'break', 'continue', 'return', 'try', 'except',
      'finally', 'raise', 'with', 'yield', 'import', 'from', 'pass', 'await'],
    types: ['int', 'str', 'float', 'bool', 'list', 'dict', 'set', 'tuple', 'object', 'bytes', 'type',
      'frozenset', 'complex'],
  },
};

function wordCases(fallback) {
  return {
    cases: {
      '@controlKeywords': 'keyword.control',
      '@keywords': 'keyword',
      '@types': 'type',
      '~[A-Z][A-Z0-9_]+': 'constant', // ALL_CAPS: INT_MIN, MAX_VALUE
      '~[A-Z][\\w$]*': 'type', // Capitalized: classes like ListNode, HashMap
      '@default': fallback,
    },
  };
}

function enhance(def, id) {
  const extra = EXTRA[id];
  const language = { ...def.language, ...extra, tokenizer: {} };
  for (const [state, rules] of Object.entries(def.language.tokenizer)) {
    language.tokenizer[state] = rules.flatMap((rule) => {
      const isWordRule = Array.isArray(rule) && rule[0] instanceof RegExp && rule[1] && rule[1].cases && '@keywords' in rule[1].cases;
      if (isWordRule) {
        return [
          [new RegExp(`${rule[0].source}(?=\\s*\\()`), wordCases('function')], // name followed by "(" is a call
          [rule[0], wordCases('identifier')],
        ];
      }
      if (id === 'python' && Array.isArray(rule)) {
        // Monaco tags Python's quote characters as escapes; VS Code colors them as strings.
        return [rule.map((part) => (part === 'string.escape' ? 'string' : part))];
      }
      return [rule];
    });
  }
  if (id === 'python') {
    // Monaco only highlights comments that start a line.
    language.tokenizer.whitespace = [...language.tokenizer.whitespace, [/#.*$/, 'comment']];
  }
  return language;
}

for (const [id, def] of [['java', javaDef], ['cpp', cppDef], ['python', pythonDef]]) {
  monaco.languages.register({ id });
  monaco.languages.setLanguageConfiguration(id, def.conf);
  monaco.languages.setMonarchTokensProvider(id, enhance(def, id));
}

// ---- editor themes, one per page theme -----------------------------------------

const LIGHT_PLUS = {
  '': '3b3b3b', comment: '008000', keyword: '0000ff', 'keyword.control': 'af00db', 'keyword.directive': 'af00db',
  function: '795e26', type: '267f99', identifier: '001080', constant: '0070c1', string: 'a31515',
  'string.escape': 'ee0000', number: '098658', delimiter: '3b3b3b', operator: '3b3b3b', annotation: '795e26', tag: '795e26',
};
const DARK_PLUS = {
  '': 'cccccc', comment: '6a9955', keyword: '569cd6', 'keyword.control': 'c586c0', 'keyword.directive': 'c586c0',
  function: 'dcdcaa', type: '4ec9b0', identifier: '9cdcfe', constant: '4fc1ff', string: 'ce9178',
  'string.escape': 'd7ba7d', number: 'b5cea8', delimiter: 'd4d4d4', operator: 'd4d4d4', annotation: 'dcdcaa', tag: 'dcdcaa',
};
// The original themes keep their own palette.
const WHITEBOARD = {
  '': '1b2a41', comment: '8794a6', keyword: '6930c3', 'keyword.control': '6930c3', 'keyword.directive': '6930c3',
  function: '2059d6', type: '0b6b80', identifier: '1b2a41', constant: 'b8410c', string: '11704f',
  'string.escape': '11704f', number: 'b8410c', delimiter: '5d6d84', operator: '5d6d84', annotation: '2059d6', tag: '2059d6',
};
const CHALKBOARD = {
  '': 'e6eee9', comment: '7d958b', keyword: 'c6a8ff', 'keyword.control': 'c6a8ff', 'keyword.directive': 'c6a8ff',
  function: '8fc0ff', type: '7fd6e8', identifier: 'e6eee9', constant: 'ffb07c', string: '84e1b8',
  'string.escape': '84e1b8', number: 'ffb07c', delimiter: '9db1a8', operator: '9db1a8', annotation: '8fc0ff', tag: '8fc0ff',
};

const EDITOR_THEMES = {
  'vscode-light': { base: 'vs', tokens: LIGHT_PLUS, bg: '#ffffff', lineNumber: '#6e7681', activeLineNumber: '#171184' },
  'vscode-dark': { base: 'vs-dark', tokens: DARK_PLUS, bg: '#1f1f1f', lineNumber: '#6e7681', activeLineNumber: '#cccccc' },
  'leetcode-dark': { base: 'vs-dark', tokens: DARK_PLUS, bg: '#262626', lineNumber: '#6e6e6e', activeLineNumber: '#e6e6e6' },
  whiteboard: { base: 'vs', tokens: WHITEBOARD, bg: '#ffffff', lineNumber: '#5d6d84', activeLineNumber: '#1b2a41' },
  chalkboard: { base: 'vs-dark', tokens: CHALKBOARD, bg: '#192822', lineNumber: '#9db1a8', activeLineNumber: '#e6eee9' },
};

for (const [name, t] of Object.entries(EDITOR_THEMES)) {
  monaco.editor.defineTheme(`cv-${name}`, {
    base: t.base,
    inherit: true,
    rules: Object.entries(t.tokens).map(([token, foreground]) => ({ token, foreground })),
    colors: {
      'editor.background': t.bg,
      'editorGutter.background': t.bg,
      'editorLineNumber.foreground': t.lineNumber,
      'editorLineNumber.activeForeground': t.activeLineNumber,
      'editor.lineHighlightBackground': '#00000000',
      'editor.lineHighlightBorder': '#00000000',
    },
  });
}

export const editorTheme = (resolvedTheme) => `cv-${EDITOR_THEMES[resolvedTheme] ? resolvedTheme : 'vscode-dark'}`;
export { monaco };
