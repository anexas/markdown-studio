import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars, drawSelection, dropCursor } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

export interface EditorEnv {
  view: EditorView;
  /** Shared by every tab so buffers behave identically. */
  extensions: Extension[];
  setTheme: (dark: boolean) => void;
  onThemeChange: (handler: (dark: boolean) => void) => void;
  isDark: () => boolean;
}

export interface EditorCallbacks {
  onDocChanged: () => void;
  onSelectionChanged: () => void;
}

/**
 * Body text a touch lighter than the stock themes so long documents read more easily:
 * oneDark's #abb2bf is dim on a dark background. The light theme only softens the
 * near-black, which still clears WCAG AA on white.
 */
function themeFor(dark: boolean): Extension[] {
  const color = dark ? "#d7dee8" : "#333b44";
  const tint = EditorView.theme({ "&": { color }, ".cm-content": { color } });
  return [dark ? oneDark : [], tint];
}

export function createEditor(host: HTMLElement, callbacks: EditorCallbacks): EditorEnv {
  const themeCompartment = new Compartment();

  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLine(),
    highlightSpecialChars(),
    drawSelection(),
    dropCursor(),
    history(),
    indentOnInput(),
    bracketMatching(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    search({ top: true }),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    EditorView.lineWrapping,
    themeCompartment.of(themeFor(darkQuery.matches)),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) callbacks.onDocChanged();
      if (update.selectionSet || update.docChanged) callbacks.onSelectionChanged();
    }),
  ];

  const view = new EditorView({
    state: EditorState.create({ doc: "", extensions }),
    parent: host,
  });

  const handlers: Array<(dark: boolean) => void> = [];
  const listener = (event: MediaQueryListEvent) => {
    view.dispatch({ effects: themeCompartment.reconfigure(themeFor(event.matches)) });
    handlers.forEach((handler) => handler(event.matches));
  };
  darkQuery.addEventListener("change", listener);

  return {
    view,
    extensions,
    setTheme(dark: boolean) {
      view.dispatch({ effects: themeCompartment.reconfigure(themeFor(dark)) });
    },
    onThemeChange(handler) {
      handlers.push(handler);
    },
    isDark: () => darkQuery.matches,
  };
}

export function createState(doc: string, extensions: Extension[]): EditorState {
  return EditorState.create({ doc, extensions });
}

export function openFindPanel(view: EditorView): void {
  openSearchPanel(view);
  view.focus();
}

/** Wraps/inserts text for the bold, italic and link commands. */
export function wrapSelection(view: EditorView, before: string, after: string, placeholder = ""): void {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const body = selected || placeholder;
  view.dispatch({
    changes: { from, to, insert: `${before}${body}${after}` },
    selection: { anchor: from + before.length, head: from + before.length + body.length },
  });
  view.focus();
}

const HEADING_PREFIX = /^#{1,6}[ \t]+/;

/**
 * Replaces the heading prefix on every line the selection touches, so pressing
 * Heading 2 on an existing "# Title" line retypes it instead of stacking hashes.
 */
export function setHeading(view: EditorView, level: number): void {
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc;
  const prefix = `${"#".repeat(level)} `;
  const changes: Array<{ from: number; to: number; insert: string }> = [];

  for (let number = doc.lineAt(from).number; number <= doc.lineAt(to).number; number += 1) {
    const line = doc.line(number);
    const existing = HEADING_PREFIX.exec(line.text);
    changes.push({ from: line.from, to: line.from + (existing ? existing[0].length : 0), insert: prefix });
  }

  // CodeMirror maps an insertion made exactly at the caret to a position *before* the
  // inserted text, which parked the cursor at the start of the line. Rebuild the caret
  // position so it keeps the same offset into the heading text.
  const caret = (pos: number): number => {
    const line = doc.lineAt(pos);
    const existing = HEADING_PREFIX.exec(line.text);
    const strip = existing ? existing[0].length : 0;
    const column = Math.max(pos - line.from, strip);
    return line.from + prefix.length + (column - strip);
  };

  view.dispatch({
    changes,
    selection: { anchor: caret(from), head: caret(to) },
    scrollIntoView: true,
  });
  view.focus();
}

/**
 * Inserts a standalone block at the caret, keeping it on its own lines, and selects
 * `selectFrom`..`selectTo` of the inserted text so a placeholder can be typed over.
 */
function insertSnippet(view: EditorView, text: string, selectFrom: number, selectTo: number): void {
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc;
  const lead = from === 0 || doc.sliceString(from - 1, from) === "\n" ? "" : "\n";
  const trail = to >= doc.length || doc.sliceString(to, to + 1) === "\n" ? "" : "\n";

  view.dispatch({
    changes: { from, to, insert: `${lead}${text}${trail}` },
    selection: { anchor: from + lead.length + selectFrom, head: from + lead.length + selectTo },
    scrollIntoView: true,
  });
  view.focus();
}

export function insertCodeBlock(view: EditorView): void {
  const { from, to } = view.state.selection.main;
  const body = view.state.sliceDoc(from, to) || "code";
  const text = `\`\`\`\n${body}\n\`\`\``;
  insertSnippet(view, text, 4, 4 + body.length);
}

export function insertTable(view: EditorView): void {
  const head = "Column 1";
  const text = `| ${head} | Column 2 | Column 3 |\n| --- | --- | --- |\n| Cell | Cell | Cell |`;
  insertSnippet(view, text, 2, 2 + head.length);
}

export function insertText(view: EditorView, text: string, cursorOffset = text.length): void {
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + cursorOffset },
  });
  view.focus();
}

export function cursorPosition(state: EditorState): { line: number; column: number } {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return { line: line.number, column: head - line.from + 1 };
}
