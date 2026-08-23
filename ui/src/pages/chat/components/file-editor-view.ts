import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";

export type FileEditorDecorations = {
  targetLine?: number | null;
  matches?: readonly number[];
  currentMatch?: number | null;
};

export type FileEditorViewHandle = {
  destroy: () => void;
  setContent: (content: string) => void;
  setEditable: (editable: boolean) => void;
  setDecorations: (decorations: FileEditorDecorations) => void;
  scrollToLine: (line: number, center: boolean) => void;
  getContent: () => string;
  onDocChanged: (callback: (content: string) => void) => void;
  focus: () => void;
};

const setLineDecorations = StateEffect.define<DecorationSet>();
const lineDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (value, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(setLineDecorations)) {
        return effect.value;
      }
    }
    return value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

async function loadLanguage(name: string) {
  const description = LanguageDescription.matchFilename(languages, name);
  if (!description) {
    return null;
  }
  try {
    return await description.load();
  } catch {
    return null;
  }
}

// Saves must round-trip the file's original bytes, so CRLF/CR files configure
// CodeMirror's line separator instead of silently normalizing to LF on save.
function detectLineSeparator(content: string): string | undefined {
  const match = content.match(/\r\n|\r|\n/);
  return match && match[0] !== "\n" ? match[0] : undefined;
}

export async function createFileEditorView(params: {
  parent: HTMLElement;
  content: string;
  name: string;
  editable?: boolean;
  onSave: () => void;
}): Promise<FileEditorViewHandle> {
  const editable = new Compartment();
  const language = await loadLanguage(params.name);
  let docChanged: ((content: string) => void) | null = null;
  let destroyed = false;
  let isEditable = params.editable === true;
  let separator = detectLineSeparator(params.content);

  const buildState = (content: string) =>
    EditorState.create({
      doc: content,
      extensions: [
        // The lineSeparator facet is static, so separator changes require a
        // full state rebuild (see setContent below).
        ...(separator ? [EditorState.lineSeparator.of(separator)] : []),
        lineNumbers(),
        highlightSpecialChars(),
        history(),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              params.onSave();
              return true;
            },
          },
        ]),
        syntaxHighlighting(classHighlighter),
        ...(language ? [language] : []),
        editable.of([EditorState.readOnly.of(!isEditable), EditorView.editable.of(isEditable)]),
        lineDecorations,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            docChanged?.(update.state.sliceDoc());
          }
        }),
      ],
    });

  params.parent.replaceChildren();
  const view = new EditorView({
    parent: params.parent,
    // The app shell is slotted through the tooltip provider's shadow root, so
    // CodeMirror's default root detection lands there and mounts its base
    // theme where slotted light-DOM content can't see it. The panel lives in
    // the document's light DOM, so the document is the correct style root.
    root: document,
    state: buildState(params.content),
  });

  const clampLine = (line: number) => Math.max(1, Math.min(Math.floor(line), view.state.doc.lines));

  return {
    destroy: () => {
      if (!destroyed) {
        destroyed = true;
        view.destroy();
      }
    },
    setContent: (content) => {
      if (destroyed) {
        return;
      }
      const nextSeparator = detectLineSeparator(content);
      if (nextSeparator !== separator) {
        separator = nextSeparator;
        view.setState(buildState(content));
        return;
      }
      if (content === view.state.sliceDoc()) {
        return;
      }
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
    },
    setEditable: (nextEditable) => {
      if (destroyed) {
        return;
      }
      // Tracked so a setContent state rebuild keeps the current edit mode.
      isEditable = nextEditable;
      view.dispatch({
        effects: editable.reconfigure([
          EditorState.readOnly.of(!nextEditable),
          EditorView.editable.of(nextEditable),
        ]),
      });
    },
    setDecorations: ({ targetLine, matches = [], currentMatch }) => {
      if (destroyed) {
        return;
      }
      const matchingLines = new Set(matches);
      const lineNumbersToDecorate = new Set(matches);
      if (targetLine != null) {
        lineNumbersToDecorate.add(targetLine);
      }
      if (currentMatch != null) {
        lineNumbersToDecorate.add(currentMatch);
      }
      const decorations = [...lineNumbersToDecorate]
        .filter((line) => Number.isInteger(line) && line >= 1 && line <= view.state.doc.lines)
        .toSorted((a, b) => a - b)
        .map((line) => {
          const classes: string[] = [];
          if (line === targetLine) {
            classes.push("file-view__line--target");
          }
          if (matchingLines.has(line)) {
            classes.push("file-view__line--match");
          }
          if (line === currentMatch) {
            classes.push("file-view__line--current");
          }
          return Decoration.line({
            class: classes.join(" "),
            ...(line === targetLine ? { attributes: { "data-line": String(line) } } : {}),
          }).range(view.state.doc.line(line).from);
        });
      view.dispatch({ effects: setLineDecorations.of(Decoration.set(decorations)) });
    },
    scrollToLine: (line, center) => {
      if (destroyed) {
        return;
      }
      view.dispatch({
        effects: EditorView.scrollIntoView(view.state.doc.line(clampLine(line)).from, {
          y: center ? "center" : "nearest",
        }),
      });
    },
    // sliceDoc serializes with the configured line separator; doc.toString()
    // would normalize CRLF/CR files to LF and corrupt saves.
    getContent: () => view.state.sliceDoc(),
    onDocChanged: (callback) => {
      docChanged = callback;
    },
    focus: () => view.focus(),
  };
}
