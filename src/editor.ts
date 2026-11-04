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

interface LineEdit {
  from: number;
  to: number;
  insert: string;
}

/** Lines touched by the selection. Blank filler lines are skipped unless they are all you selected. */
function selectedLines(state: EditorState): Array<{ from: number; to: number; text: string }> {
  const { from, to } = state.selection.main;
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to).number;
  const lines: Array<{ from: number; to: number; text: string }> = [];

  for (let number = first; number <= last; number += 1) {
    const line = state.doc.line(number);
    if (line.text.trim() === "" && first !== last) continue;
    lines.push({ from: line.from, to: line.to, text: line.text });
  }
  return lines;
}

function indentLength(text: string): number {
  return text.length - text.trimStart().length;
}

/** Marker length of any list line, counting leading whitespace, or 0 when there is none. */
const LIST_MARKER = /^(\s*)(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/;

function markerLength(text: string): number {
  const match = LIST_MARKER.exec(text);
  return match ? match[0].length : 0;
}

/**
 * Applies per-line edits and keeps the selection in place. CodeMirror maps an insertion
 * made exactly at the caret to the position *before* the inserted text, which parked the
 * caret at the start of the line; the delta walk below restores the intended offset.
 */
function applyLineEdits(view: EditorView, edits: LineEdit[]): void {
  if (edits.length === 0) return;
  const { from, to } = view.state.selection.main;

  const mapPos = (pos: number): number => {
    let shift = 0;
    for (const edit of edits) {
      if (pos >= edit.to) shift += edit.insert.length - (edit.to - edit.from);
      else if (pos > edit.from) return shift + edit.from + edit.insert.length;
    }
    return pos + shift;
  };

  view.dispatch({ changes: edits, selection: { anchor: mapPos(from), head: mapPos(to) } });
  view.focus();
}

/**
 * Shared list toggle: markers are added to every touched line, or stripped when they are
 * all already that kind of list. Converting between list types replaces the existing
 * marker instead of stacking one on top of another.
 */
function toggleList(
  view: EditorView,
  marked: RegExp,
  markerFor: (index: number) => string,
  keep?: (text: string) => boolean,
): void {
  const lines = selectedLines(view.state).filter((line) => !keep?.(line.text));
  if (lines.length === 0) return;

  const remove = lines.every((line) => marked.test(line.text));
  const edits: LineEdit[] = [];

  lines.forEach((line, index) => {
    const indent = indentLength(line.text);
    const existing = markerLength(line.text);
    const start = line.from + indent;

    if (remove) {
      if (existing > 0) edits.push({ from: start, to: line.from + existing, insert: "" });
      return;
    }
    edits.push({ from: start, to: existing > 0 ? line.from + existing : start, insert: markerFor(index) });
  });

  applyLineEdits(view, edits);
}

const TASK_ITEM = /^(\s*)[-*+][ \t]+\[[ xX]\][ \t]+/;

export function toggleBulletList(view: EditorView): void {
  // A task item is already a bullet with a checkbox. Converting it here would delete
  // every checked state in one keystroke, so tasks are left exactly as they are.
  toggleList(view, /^(\s*)[-*+][ \t]+(?!\[[ xX]\])/, () => "- ", (text) => TASK_ITEM.test(text));
}

export function toggleOrderedList(view: EditorView): void {
  toggleList(view, /^(\s*)\d+[.)]\s+/, (index) => `${index + 1}. `);
}

export function toggleTaskList(view: EditorView): void {
  toggleList(view, TASK_ITEM, () => "- [ ] ");
}

const QUOTE_PREFIX = /^(\s*)>\s?/;

export function toggleBlockquote(view: EditorView): void {
  const lines = selectedLines(view.state);
  if (lines.length === 0) return;

  const remove = lines.every((line) => QUOTE_PREFIX.test(line.text));
  const edits: LineEdit[] = [];

  for (const line of lines) {
    const indent = indentLength(line.text);
    const start = line.from + indent;
    const match = QUOTE_PREFIX.exec(line.text);

    if (remove) {
      if (match) edits.push({ from: start, to: line.from + match[0].length, insert: "" });
      continue;
    }
    edits.push({ from: start, to: start, insert: "> " });
  }

  applyLineEdits(view, edits);
}

/** Inline token toggle shared by inline code and strikethrough. */
function toggleWrapSymbol(view: EditorView, token: string, placeholder: string): void {
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc;
  const selected = doc.sliceString(from, to);

  // Selection includes the delimiters: unwrap in place.
  if (selected.length >= token.length * 2 && selected.startsWith(token) && selected.endsWith(token)) {
    const inner = selected.slice(token.length, selected.length - token.length);
    view.dispatch({ changes: { from, to, insert: inner }, selection: { anchor: from, head: from + inner.length } });
    view.focus();
    return;
  }

  // Delimiters sit just outside the selection: remove them and keep the text selected.
  const before = doc.sliceString(Math.max(0, from - token.length), from);
  const after = doc.sliceString(to, Math.min(doc.length, to + token.length));
  if (before === token && after === token) {
    view.dispatch({
      changes: [
        { from: from - token.length, to: from, insert: "" },
        { from: to, to: to + token.length, insert: "" },
      ],
      selection: { anchor: from - token.length, head: to - token.length },
    });
    view.focus();
    return;
  }

  const body = selected || placeholder;
  view.dispatch({
    changes: { from, to, insert: `${token}${body}${token}` },
    selection: { anchor: from + token.length, head: from + token.length + body.length },
  });
  view.focus();
}

export function toggleInlineCode(view: EditorView): void {
  toggleWrapSymbol(view, "`", "code");
}

export function toggleStrikethrough(view: EditorView): void {
  toggleWrapSymbol(view, "~~", "text");
}

export function insertHorizontalRule(view: EditorView): void {
  insertSnippet(view, "---", 3, 3);
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
