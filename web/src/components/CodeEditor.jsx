import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Annotation, Compartment, EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands';
import { HighlightStyle, bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { python } from '@codemirror/lang-python';
import { tags as t } from '@lezer/highlight';

const LANGUAGE_SUPPORT = { java, cpp, python };

// Colors come from CSS variables, so light and dark themes both work.
const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.modifier, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: 'var(--syn-keyword)', fontWeight: '600' },
  { tag: [t.function(t.definition(t.variableName)), t.definition(t.className), t.function(t.variableName)], color: 'var(--syn-def)' },
  { tag: [t.string, t.special(t.string), t.character], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.typeName, t.className, t.standard(t.variableName), t.processingInstruction, t.macroName], color: 'var(--syn-builtin)' },
  { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--ink-soft)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--panel)', color: 'var(--ink)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-code)', fontSize: '14px', lineHeight: '1.6', fontVariantLigatures: 'none' },
  '.cm-content': { caretColor: 'var(--ink)' },
  '.cm-cursor': { borderLeft: '2px solid var(--ink)' },
  '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--ink-soft)', borderRight: '1px solid var(--rule)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 6px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--p0) 22%, transparent) !important' },
  '.cm-matchingBracket': { backgroundColor: 'transparent', textDecoration: 'underline 2px var(--p0)' },
});

// ---- line highlights for the current step ---------------------------------

const setMarks = StateEffect.define();
const marksField = StateField.define({
  create: () => Decoration.none,
  update(marks, tr) {
    let next = marks.map(tr.changes); // highlights follow their line while you edit
    for (const effect of tr.effects) {
      if (effect.is(setMarks)) next = effect.value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const programmatic = Annotation.define();

function tabKey(view) {
  if (view.state.selection.ranges.some((r) => !r.empty)) return indentMore(view);
  view.dispatch(view.state.replaceSelection('    '));
  return true;
}

/**
 * The code editor. Props: initialCode, lang, marks {current, previous, error}, onChange(code), onRun().
 * Ref methods: setCode(code), getCode().
 */
const CodeEditor = forwardRef(function CodeEditor({ initialCode, lang, marks, onChange, onRun }, ref) {
  const host = useRef(null);
  const view = useRef(null);
  const language = useRef(new Compartment());
  const callbacks = useRef({ onChange, onRun });
  callbacks.current = { onChange, onRun };

  useEffect(() => {
    const state = EditorState.create({
      doc: initialCode,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        EditorState.tabSize.of(4),
        indentUnit.of('    '),
        syntaxHighlighting(highlightStyle),
        theme,
        marksField,
        language.current.of(LANGUAGE_SUPPORT[lang]()),
        keymap.of([
          { key: 'Mod-Enter', run: () => { callbacks.current.onRun(); return true; } },
          { key: 'Tab', run: tabKey },
          { key: 'Shift-Tab', run: indentLess },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.contentAttributes.of({ 'aria-label': 'Code' }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((tr) => tr.annotation(programmatic))) {
            callbacks.current.onChange(update.state.doc.toString());
          }
        }),
      ],
    });
    view.current = new EditorView({ state, parent: host.current });
    return () => view.current.destroy();
    // The editor is created once; later prop changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current.dispatch({ effects: language.current.reconfigure(LANGUAGE_SUPPORT[lang]()) });
  }, [lang]);

  useEffect(() => {
    const v = view.current;
    const doc = v.state.doc;
    const ranges = [];
    const add = (line, cls) => {
      if (line == null || line < 1 || line > doc.lines) return;
      ranges.push(Decoration.line({ class: cls }).range(doc.line(line).from));
    };
    const { current, previous, error } = marks;
    add(previous && previous !== current ? previous : null, 'line-prev');
    add(current, error ? 'line-error' : 'line-next');
    ranges.sort((a, b) => a.from - b.from);
    const effects = [setMarks.of(Decoration.set(ranges))];
    if (current && current <= doc.lines) {
      effects.push(EditorView.scrollIntoView(doc.line(current).from, { y: 'nearest', yMargin: 80 }));
    }
    v.dispatch({ effects });
  }, [marks]);

  useImperativeHandle(ref, () => ({
    setCode(code) {
      const v = view.current;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: code }, annotations: programmatic.of(true) });
    },
    getCode: () => view.current.state.doc.toString(),
  }), []);

  return <div className="editor" ref={host} />;
});

export default CodeEditor;
