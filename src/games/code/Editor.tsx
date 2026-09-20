// The person's editor: CodeMirror, one state per file so every tab keeps its own undo history,
// cursor and scroll position.

import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { indentUnit } from '@codemirror/language';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13.5px', backgroundColor: '#fff' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-gutters': { backgroundColor: 'var(--color-paper)', color: 'color-mix(in srgb, var(--color-ink) 45%, transparent)', borderRight: '2px solid color-mix(in srgb, var(--color-ink) 15%, transparent)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--color-sun) 22%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--color-sun) 45%, transparent)' },
  '&.cm-focused': { outline: 'none' },
});

const language = (name: string): Extension => (name.endsWith('.md') ? markdown() : javascript({ typescript: name.endsWith('.ts') }));

export function Editor({
  files,
  active,
  editable,
  writable,
  onEdit,
  onRunTests,
  onSubmit,
}: {
  /** Read once per file name, when its tab is first built; after that the editor owns the text. */
  files: Record<string, string>;
  active: string;
  editable: boolean;
  /** Whether this file is the person's to change: the repository's own tests are shown, not edited. */
  writable: (name: string) => boolean;
  onEdit: (name: string, content: string) => void;
  onRunTests: () => void;
  onSubmit: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const shown = useRef('');
  const lock = useRef(new Compartment());
  // The editor outlives renders; its callbacks must reach the latest props.
  const latest = useRef({ onEdit, onRunTests, onSubmit });
  latest.current = { onEdit, onRunTests, onSubmit };

  useEffect(() => {
    view.current = new EditorView({ parent: host.current! });
    return () => view.current?.destroy();
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v || files[active] === undefined) return;
    // Locking and unlocking (a submission being verified) must not reset the tab that is open.
    if (shown.current !== active) {
      if (shown.current) states.current.set(shown.current, v.state);
      const state =
        states.current.get(active) ??
        EditorState.create({
          doc: files[active],
          extensions: [
            // Before the defaults, so Mod-Enter is a submission rather than a new line.
            Prec.highest(
              keymap.of([
                { key: 'Mod-s', preventDefault: true, run: () => (latest.current.onRunTests(), true) },
                { key: 'Mod-Enter', preventDefault: true, run: () => (latest.current.onSubmit(), true) },
              ]),
            ),
            basicSetup,
            keymap.of([indentWithTab]),
            // The repository is indented with tabs.
            indentUnit.of('\t'),
            EditorState.tabSize.of(2),
            language(active),
            theme,
            lock.current.of([]),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) latest.current.onEdit(active, update.state.doc.toString());
            }),
          ],
        });
      shown.current = active;
      v.setState(state);
    }
    const open = editable && writable(active);
    v.dispatch({ effects: lock.current.reconfigure([EditorState.readOnly.of(!open), EditorView.editable.of(open)]) });
    if (open) v.focus();
    // `files` changes identity on every keystroke's re-render; only a new tab or lock matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, editable, files[active] === undefined]);

  return <div ref={host} className="h-[min(44vh,420px)] min-h-64 overflow-hidden" />;
}
