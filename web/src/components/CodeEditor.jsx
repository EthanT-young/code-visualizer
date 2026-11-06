import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { editorTheme, monaco } from '../lib/monacoSetup.js';

const codeFont = () => getComputedStyle(document.documentElement).getPropertyValue('--font-code').trim();

/**
 * The code editor (Monaco). Props: initialCode, lang, theme (resolved page theme),
 * marks {current, previous, error}, onChange(code), onRun().
 * Ref methods: setCode(code), getCode().
 */
const CodeEditor = forwardRef(function CodeEditor({ initialCode, lang, theme, marks, onChange, onRun }, ref) {
  const host = useRef(null);
  const editor = useRef(null);
  const decorations = useRef(null);
  const programmatic = useRef(false);
  const callbacks = useRef({ onChange, onRun });
  callbacks.current = { onChange, onRun };

  useEffect(() => {
    const ed = monaco.editor.create(host.current, {
      value: initialCode,
      language: lang,
      theme: editorTheme(theme),
      ariaLabel: 'Code',
      automaticLayout: true,
      fontFamily: codeFont(),
      fontSize: 14,
      lineHeight: 22,
      fontLigatures: false,
      tabSize: 4,
      insertSpaces: true,
      detectIndentation: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'none',
      lineNumbersMinChars: 3,
      lineDecorationsWidth: 10,
      glyphMargin: false,
      folding: false,
      padding: { top: 8, bottom: 8 },
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      bracketPairColorization: { enabled: true },
      guides: { indentation: true, bracketPairs: false },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      fixedOverflowWidgets: true,
    });
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => callbacks.current.onRun());
    ed.onDidChangeModelContent(() => {
      if (!programmatic.current) callbacks.current.onChange(ed.getValue());
    });
    decorations.current = ed.createDecorationsCollection();
    editor.current = ed;
    // Re-measure once web fonts finish loading so the cursor lines up with the text.
    document.fonts?.ready.then(() => monaco.editor.remeasureFonts());
    return () => {
      ed.getModel()?.dispose();
      ed.dispose();
    };
    // The editor is created once; later prop changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    monaco.editor.setModelLanguage(editor.current.getModel(), lang);
  }, [lang]);

  useEffect(() => {
    monaco.editor.setTheme(editorTheme(theme));
    editor.current.updateOptions({ fontFamily: codeFont() });
    document.fonts?.ready.then(() => monaco.editor.remeasureFonts());
  }, [theme]);

  // Highlight the line about to run (and the one that just ran). Decorations follow
  // their line while you edit.
  useEffect(() => {
    const ed = editor.current;
    const lineCount = ed.getModel().getLineCount();
    const valid = (line) => line != null && line >= 1 && line <= lineCount;
    const { current, previous, error } = marks;
    const list = [];
    if (valid(previous) && previous !== current) {
      list.push({ range: new monaco.Range(previous, 1, previous, 1), options: { isWholeLine: true, className: 'line-prev' } });
    }
    if (valid(current)) {
      const cls = error ? 'line-error' : 'line-next';
      list.push({
        range: new monaco.Range(current, 1, current, ed.getModel().getLineMaxColumn(current)),
        options: { isWholeLine: true, className: cls, linesDecorationsClassName: `${cls}-marker`, inlineClassName: `${cls}-text` },
      });
      ed.revealLineInCenterIfOutsideViewport(current);
    }
    decorations.current.set(list);
  }, [marks]);

  useImperativeHandle(ref, () => ({
    setCode(code) {
      programmatic.current = true;
      editor.current.setValue(code);
      programmatic.current = false;
    },
    getCode: () => editor.current.getValue(),
  }), []);

  return <div className="editor" ref={host} />;
});

export default CodeEditor;
