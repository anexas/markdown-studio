import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog, ask, message } from "@tauri-apps/plugin-dialog";
import { redo, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";

import {
  createEditor,
  createState,
  cursorPosition,
  insertCodeBlock,
  insertHorizontalRule,
  insertTable,
  openFindPanel,
  setHeading,
  toggleBlockquote,
  toggleBulletList,
  toggleInlineCode,
  toggleOrderedList,
  toggleStrikethrough,
  toggleTaskList,
  wrapSelection,
} from "./editor";
import type { EditorEnv } from "./editor";
import { createWysiwyg, minimalChange } from "./wysiwyg";
import type { Wysiwyg } from "./wysiwyg";
import { hydratePreview, renderToHtml } from "./render";
import { Sidebar, isUnderRoot } from "./sidebar";
import { ZOOM_MAX, ZOOM_MIN, clampWidth, clampZoom, loadSession, pushRecent, saveSession } from "./session";
import { DEFAULT_PREFS, hasPrefs, loadPrefs, savePrefs } from "./prefs";
import type { Prefs } from "./prefs";
import { exportDocHtml } from "./export";
import { applyCustomCss, clearCustomCss } from "./theme";
import { baseName, dirName, isMarkdownPath } from "./types";
import type { Doc, DocPayload, PaneView, ViewMode } from "./types";

const appWindow = getCurrentWindow();

function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

const el = {
  toolbar: must<HTMLElement>("toolbar"),
  breadcrumb: must<HTMLElement>("breadcrumb"),
  sidebar: must<HTMLElement>("sidebar"),
  resizer: must<HTMLElement>("sidebar-resizer"),
  tabstrip: must<HTMLElement>("tabstrip"),
  editorHost: must<HTMLElement>("editor-host"),
  previewScroll: must<HTMLElement>("preview-scroll"),
  preview: must<HTMLElement>("preview"),
  paneLabel: must<HTMLElement>("pane-label"),
  paneToggle: must<HTMLButtonElement>("pane-toggle"),
  sidebarTitle: must<HTMLElement>("sidebar-title"),
  tree: must<HTMLElement>("tree"),
  statFile: must<HTMLElement>("stat-file"),
  statSave: must<HTMLElement>("stat-save"),
  statCursor: must<HTMLElement>("stat-cursor"),
  statWords: must<HTMLElement>("stat-words"),
  statEol: must<HTMLElement>("stat-eol"),
  statEnc: must<HTMLElement>("stat-enc"),
  statMode: must<HTMLElement>("stat-mode"),
  dropOverlay: must<HTMLElement>("drop-overlay"),
  shell: must<HTMLElement>("shell"),
  prefsBackdrop: must<HTMLElement>("prefs-backdrop"),
  prefsHome: must<HTMLInputElement>("prefs-home"),
  prefsBrowse: must<HTMLButtonElement>("prefs-browse"),
  prefsClear: must<HTMLButtonElement>("prefs-clear"),
  prefsSidebar: must<HTMLInputElement>("prefs-sidebar"),
  prefsAutosave: must<HTMLInputElement>("prefs-autosave"),
  prefsCss: must<HTMLInputElement>("prefs-css"),
  prefsCssBrowse: must<HTMLButtonElement>("prefs-css-browse"),
  prefsCssClear: must<HTMLButtonElement>("prefs-css-clear"),
  diskBanner: must<HTMLElement>("disk-banner"),
  diskBannerText: must<HTMLElement>("disk-banner-text"),
  diskReload: must<HTMLButtonElement>("disk-reload"),
  diskKeep: must<HTMLButtonElement>("disk-keep"),
  prefsSave: must<HTMLButtonElement>("prefs-save"),
  prefsCancel: must<HTMLButtonElement>("prefs-cancel"),
};

let env: EditorEnv;
let docs: Doc[] = [];
let activeIndex = -1;
let mode: ViewMode = "split";
let paneView: PaneView = "rendered";
let recent: string[] = [];
let sidebarVisible = false;
let sidebarWidth = 240;
let docSeq = 0;
let zoom = 1;
let prefs: Prefs = { ...DEFAULT_PREFS };
let prefsHomeDraft: string | null = null;
let prefsCssDraft: string | null = null;
let prefsOpen = false;

let autosaveTimer = 0;
let diskTimer = 0;
let saveStateTimer = 0;
/** The buffer whose on-disk change is waiting for a decision. */
let conflictDocId: string | null = null;

const ZOOM_STEP = 0.1;

let renderTimer = 0;
let statusTimer = 0;
let sessionTimer = 0;
let scrollLockSource: "editor" | "preview" | "" = "";
let scrollLockUntil = 0;
let wys: Wysiwyg | null = null;
/** Set while a preview edit is being pushed into CodeMirror, so it is not mirrored back. */
let editingPreview = false;

const sidebar = new Sidebar(
  el.tree,
  el.sidebarTitle,
  (path) => {
    void openPath(path);
  },
  // Same path as Open Folder: re-roots, reveals the focused document if it is under the
  // new root, and persists the change.
  (dir) => {
    void openFolder(dir);
  },
);

function activeDoc(): Doc | undefined {
  return docs[activeIndex];
}

function contentOf(doc: Doc): string {
  const state = doc === activeDoc() ? env?.view.state : doc.state;
  return state ? state.doc.toString() : doc.savedContent;
}

function isDirty(doc: Doc): boolean {
  return contentOf(doc) !== doc.savedContent;
}

function hasUnsaved(): boolean {
  return docs.some(isDirty);
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();
}

function makeDoc(content: string, path: string | null, eol: "\n" | "\r\n", bom: boolean): Doc {
  docSeq += 1;
  return {
    id: `doc-${docSeq}`,
    path,
    name: path ? baseName(path) : "Untitled",
    dir: path ? dirName(path) : null,
    eol,
    bom,
    savedContent: content,
    stamp: null,
    conflict: false,
    state: createState(content, env.extensions),
    editorScroll: 0,
    previewScroll: 0,
  };
}

/* ---------------------------------------------------------------- rendering */

function destroyWysiwyg(): void {
  if (!wys) return;
  wys.destroy();
  wys = null;
  el.preview.replaceChildren();
}

/** Push a preview edit into the buffer that owns the text. */
function applyPreviewEdit(markdown: string, anchor: number, head: number): void {
  if (!activeDoc()) return;
  const current = env.view.state.doc.toString();
  const selection = {
    anchor: Math.min(anchor, markdown.length),
    head: Math.min(head, markdown.length),
  };
  const change = minimalChange(current, markdown);
  const untouched = change.from === change.to && change.insert === "";

  editingPreview = true;
  // The preview is the pane being edited, so the source pane's scroll events must not
  // drag the rendered pane around while this edit settles.
  scrollLockSource = "preview";
  scrollLockUntil = performance.now() + 250;
  try {
    env.view.dispatch({
      changes: untouched ? undefined : change,
      selection,
      // Keep the source caret on screen without moving it when it already is.
      effects: EditorView.scrollIntoView(selection.anchor, { y: "nearest" }),
    });
  } finally {
    editingPreview = false;
  }
}

function syncWysiwyg(doc: Doc): void {
  if (!wys) {
    // The read-only article may still be mounted from Preview mode.
    el.preview.replaceChildren();
    wys = createWysiwyg(el.preview, contentOf(doc), {
      docDir: doc.dir,
      onEdit: applyPreviewEdit,
      // Clicking in the preview moves the source caret, so toolbar commands and the
      // status bar follow the place the user is actually working in.
      onSelect: (anchor, head) => {
        const length = env.view.state.doc.length;
        const from = Math.max(0, Math.min(anchor, length));
        const to = Math.max(0, Math.min(head, length));
        const current = env.view.state.selection.main;
        if (current.anchor === from && current.head === to) return;
        env.view.dispatch({
          selection: { anchor: from, head: to },
          effects: EditorView.scrollIntoView(from, { y: "nearest" }),
        });
      },
      onUndo: () => undo(env.view),
      onRedo: () => redo(env.view),
    });
  }
  wys.setDocDir(doc.dir);
  wys.setMarkdown(contentOf(doc), env.view.state.selection.main.head);
}

/** Right pane view in Split: the editable rendered pane, or a read-only preview. */
function setPaneView(next: PaneView): void {
  paneView = next;
  document.body.dataset.pane = next;
  renderPaneBar();
  if (mode === "split") scheduleRender(true);
  scheduleSessionSave();
}

function renderPaneBar(): void {
  const readOnly = paneView === "preview";
  el.paneLabel.textContent = readOnly ? "Preview \u00B7 read-only" : "Rendered \u00B7 editable";
  el.paneToggle.setAttribute("aria-pressed", readOnly ? "true" : "false");
  el.paneToggle.title = readOnly
    ? "Switch back to the editable rendered pane (Ctrl+Alt+P)"
    : "Show the read-only preview, including tables (Ctrl+Alt+P)";
  el.paneToggle.setAttribute(
    "aria-label",
    readOnly ? "Switch to the editable rendered pane" : "Show read-only preview",
  );
}

function renderPreviewNow(): void {
  const doc = activeDoc();
  if (!doc) {
    destroyWysiwyg();
    el.preview.replaceChildren();
    return;
  }
  // Split view edits the rendered side. Preview stays a read-only render, so there is always
  // one pane that shows exactly what the file says and printing keeps a faithful target.
  if (mode === "split" && paneView === "rendered") {
    syncWysiwyg(doc);
    return;
  }
  destroyWysiwyg();
  const html = renderToHtml(contentOf(doc));
  const keep = el.previewScroll.scrollTop;
  el.preview.innerHTML = html;
  el.previewScroll.scrollTop = keep;
  void hydratePreview(el.preview, doc.dir);
}

function scheduleRender(immediate = false): void {
  if (mode === "raw") return;
  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(
    () => {
      renderPreviewNow();
    },
    immediate ? 0 : 140,
  );
}

/* -------------------------------------------------------------- scroll sync */

function ratioSync(from: HTMLElement, to: HTMLElement): void {
  const maxFrom = from.scrollHeight - from.clientHeight;
  const maxTo = to.scrollHeight - to.clientHeight;
  if (maxFrom <= 0 || maxTo <= 0) return;
  to.scrollTop = (from.scrollTop / maxFrom) * maxTo;
}

function onEditorScroll(): void {
  if (mode !== "split" || !env) return;
  // While the user is working in the rendered pane, that pane owns the scroll position.
  if (el.preview.contains(document.activeElement)) return;
  if (scrollLockSource === "preview" && performance.now() < scrollLockUntil) return;
  scrollLockSource = "editor";
  scrollLockUntil = performance.now() + 140;
  ratioSync(env.view.scrollDOM, el.previewScroll);
}

function onPreviewScroll(): void {
  if (mode !== "split" || !env) return;
  if (scrollLockSource === "editor" && performance.now() < scrollLockUntil) return;
  scrollLockSource = "preview";
  scrollLockUntil = performance.now() + 140;
  ratioSync(el.previewScroll, env.view.scrollDOM);
}

/* -------------------------------------------------------------- chrome/state */

function updateTitle(): void {
  const doc = activeDoc();
  if (!doc) {
    void appWindow.setTitle("Markdown Studio");
    return;
  }
  const marker = isDirty(doc) ? "\u25CF " : "";
  const suffix = doc.path ? "" : " [unsaved]";
  void appWindow.setTitle(`${marker}${doc.name}${suffix} \u2014 Markdown Studio`);
}

function updateStatus(): void {
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    const doc = activeDoc();
    const text = doc ? contentOf(doc) : "";
    const { line, column } = cursorPosition(env.view.state);
    el.statCursor.textContent = `Ln ${line}, Col ${column}`;
    el.statWords.textContent = text.length > 400_000 ? "large file" : `${text.trim() ? text.trim().split(/\s+/).length : 0} words`;
    el.statEol.textContent = doc?.eol === "\r\n" ? "CRLF" : "LF";
    el.statEnc.textContent = doc?.bom ? "UTF-8 BOM" : "UTF-8";
    el.statMode.textContent = mode === "raw" ? "Raw" : mode === "split" ? "Split" : "Preview";
    el.statFile.textContent = doc?.path ?? (doc ? "Untitled" : "");
    el.statFile.title = doc?.path ?? "";
  }, 120);
}

function renderTabs(): void {
  // A single blank document still needs a visible tab: otherwise the empty buffer
  // looks like it does not exist and Ctrl+N appears to be the only way forward.
  el.tabstrip.hidden = docs.length === 0;
  el.tabstrip.replaceChildren();
  docs.forEach((doc, index) => {
    const tab = document.createElement("div");
    tab.className = "tab";
    if (index === activeIndex) tab.classList.add("active");
    if (isDirty(doc)) tab.classList.add("dirty");
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", index === activeIndex ? "true" : "false");
    tab.title = doc.path ?? doc.name;

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = doc.name;

    const close = document.createElement("button");
    close.className = "tab-close";
    close.type = "button";
    close.textContent = "\u00D7";
    close.title = "Close tab (Ctrl+W)";
    close.setAttribute("aria-label", `Close ${doc.name}`);
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      void closeDoc(index);
    });

    tab.append(label, close);
    tab.addEventListener("click", () => activate(index));
    tab.addEventListener("auxclick", (event) => {
      if (event.button === 1) {
        event.preventDefault();
        void closeDoc(index);
      }
    });
    el.tabstrip.append(tab);
  });
}

/** Path strip under the tabs: folder segments open in the sidebar, file is the leaf. */
function renderBreadcrumb(): void {
  const doc = activeDoc();
  el.breadcrumb.replaceChildren();

  if (!doc) {
    el.breadcrumb.hidden = true;
    return;
  }
  el.breadcrumb.hidden = false;

  if (!doc.path) {
    const hint = document.createElement("span");
    hint.className = "crumb crumb-muted";
    hint.textContent = "Untitled \u2014 not saved yet";
    el.breadcrumb.append(hint);
    return;
  }

  const sep = doc.path.includes("\\") ? "\\" : "/";
  const parts = doc.path.split(/[\\/]/).filter(Boolean);
  const isUnc = /^[\\/]{2}/.test(doc.path);

  let accumulated = isUnc ? `\\${sep}${parts[0]}` : parts[0];
  // "C:" alone is a drive-relative path that cannot be listed; anchor it to the root.
  if (/^[A-Za-z]:$/.test(accumulated)) accumulated += sep;

  parts.forEach((part, index) => {
    if (index > 0) {
      accumulated = accumulated.endsWith(sep) ? accumulated + part : accumulated + sep + part;
      const divider = document.createElement("span");
      divider.className = "crumb-sep";
      divider.textContent = "\u203A";
      el.breadcrumb.append(divider);
    }

    if (index === parts.length - 1) {
      const leaf = document.createElement("span");
      leaf.className = "crumb crumb-file";
      leaf.textContent = part;
      leaf.title = doc.path ?? "";
      el.breadcrumb.append(leaf);
      return;
    }

    // Capture the value now: `accumulated` keeps growing for later segments, so a
    // handler that read it lazily would always open the file's own folder.
    const crumbPath = accumulated;
    const folder = document.createElement("button");
    folder.type = "button";
    folder.className = "crumb crumb-dir";
    folder.textContent = part;
    folder.title = `Show ${crumbPath} in the folder sidebar`;
    folder.addEventListener("click", () => void openFolder(crumbPath));
    el.breadcrumb.append(folder);
  });

  el.breadcrumb.scrollLeft = el.breadcrumb.scrollWidth;
}

function scheduleSessionSave(): void {
  window.clearTimeout(sessionTimer);
  sessionTimer = window.setTimeout(persist, 250);
}

function persist(): void {
  saveSession({
    mode,
    paneView,
    zoom,
    activeIndex: Math.max(activeIndex, 0),
    tabs: docs.filter((doc) => doc.path !== null).map((doc) => doc.path as string),
    sidebar: { root: sidebar.getRoot(), width: sidebarWidth, visible: sidebarVisible },
    recent,
  });
}

/* ---------------------------------------------------------------- documents */

function activate(index: number): void {
  if (index < 0 || index >= docs.length) return;

  // Leaving a buffer is a natural save point: autosave should not wait for the timer.
  flushAutosave();
  const current = activeDoc();
  if (current) {
    current.state = env.view.state;
    current.editorScroll = env.view.scrollDOM.scrollTop;
    current.previewScroll = el.previewScroll.scrollTop;
  }

  const next = docs[index];
  if (!next.state) next.state = createState("", env.extensions);

  activeIndex = index;
  env.view.setState(next.state);

  window.requestAnimationFrame(() => {
    env.view.scrollDOM.scrollTop = next.editorScroll;
    el.previewScroll.scrollTop = next.previewScroll;
  });

  renderPreviewNow();
  renderTabs();
  updateTitle();
  renderBreadcrumb();
  updateStatus();
  void trackInSidebar(next.path);
  if (next.conflict) showDiskBanner(next);
  else hideDiskBanner();
  scheduleSessionSave();
}

function newDoc(): void {
  // Reuse an untouched empty buffer instead of stacking identical Untitled tabs.
  const pristine = docs.findIndex((doc) => doc.path === null && !isDirty(doc) && contentOf(doc).trim() === "");
  if (pristine >= 0) {
    activate(pristine);
    env.view.focus();
    return;
  }

  docs.push(makeDoc("", null, "\n", false));
  activate(docs.length - 1);
  env.view.focus();
  renderTabs();
}

async function openPath(path: string): Promise<void> {
  const existing = docs.findIndex((doc) => doc.path !== null && samePath(doc.path, path));
  if (existing >= 0) {
    activate(existing);
    return;
  }
  try {
    const payload = await invoke<DocPayload>("read_document", { path });
    const doc = makeDoc(payload.content, path, payload.eol === "\r\n" ? "\r\n" : "\n", payload.bom);
    doc.stamp = await stampOf(path);
    docs.push(doc);
    activate(docs.length - 1);
    recent = pushRecent(recent, path);
    persist();
    if (isMarkdownPath(path)) await trackInSidebar(path);
  } catch (err) {
    await message(String(err), { title: `Could not open ${baseName(path)}`, kind: "error" });
  }
}

async function openResolved(dir: string, href: string): Promise<void> {
  const sep = dir.includes("\\") ? "\\" : "/";
  const stack = dir.split(/[\\/]/).filter(Boolean);
  for (const part of href.split(/[\\/]/)) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  await openPath(stack.join(sep));
}

async function stampOf(path: string): Promise<number | null> {
  try {
    return await invoke<number | null>("document_stamp", { path });
  } catch {
    return null;
  }
}

/**
 * Writes a buffer to disk. `quiet` is autosave: no dialog, and a failure is reported in
 * the status bar rather than interrupting with a modal the user did not ask for.
 */
async function writeDoc(doc: Doc, target: string, options: { quiet?: boolean } = {}): Promise<boolean> {
  const content = contentOf(doc);
  try {
    await invoke("write_document", { path: target, content, eol: doc.eol, bom: doc.bom });
    doc.path = target;
    doc.name = baseName(target);
    doc.dir = dirName(target);
    doc.savedContent = content;
    doc.stamp = await stampOf(target);
    doc.conflict = false;
    if (conflictDocId === doc.id) hideDiskBanner();
    recent = pushRecent(recent, target);
    renderTabs();
    updateTitle();
    renderBreadcrumb();
    updateStatus();
    persist();
    await trackInSidebar(target);
    if (options.quiet) showSaveState("Autosaved");
    return true;
  } catch (err) {
    showSaveState("Save failed", true);
    if (!options.quiet) await message(String(err), { title: "Could not save file", kind: "error" });
    return false;
  }
}

async function saveDoc(saveAs: boolean): Promise<void> {
  const doc = activeDoc();
  if (!doc) return;

  let target = doc.path;
  if (!target || saveAs) {
    const suggestion = doc.path ?? `${doc.name === "Untitled" ? "Untitled" : doc.name.replace(/\.md$/i, "")}.md`;
    const chosen = await saveDialog({
      title: "Save Markdown file",
      defaultPath: suggestion,
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      canCreateDirectories: true,
    });
    if (typeof chosen !== "string") return;
    target = chosen;
  }

  await writeDoc(doc, target);
}

/* ------------------------------------------------------------------ autosave */

const AUTOSAVE_DELAY = 1200;
const DISK_POLL_MS = 2000;

function scheduleAutosave(): void {
  window.clearTimeout(autosaveTimer);
  const doc = activeDoc();
  if (!prefs.autosave || !doc?.path || doc.conflict || !isDirty(doc)) return;
  autosaveTimer = window.setTimeout(() => void autosaveNow(), AUTOSAVE_DELAY);
}

async function autosaveNow(): Promise<void> {
  const doc = activeDoc();
  if (!doc?.path || doc.conflict || !isDirty(doc)) return;
  await writeDoc(doc, doc.path, { quiet: true });
}

/** Saves the pending edit before the buffer is switched away or the window closes. */
function flushAutosave(): void {
  window.clearTimeout(autosaveTimer);
  const doc = activeDoc();
  if (!doc?.path || doc.conflict || !isDirty(doc)) return;
  void writeDoc(doc, doc.path, { quiet: true });
}

/* ------------------------------------------------------- external changes */

function showSaveState(text: string, isError = false): void {
  el.statSave.textContent = text;
  el.statSave.classList.toggle("stat-error", isError);
  window.clearTimeout(saveStateTimer);
  saveStateTimer = window.setTimeout(() => {
    el.statSave.textContent = "";
    el.statSave.classList.remove("stat-error");
  }, isError ? 8000 : 2500);
}

function showDiskBanner(doc: Doc): void {
  conflictDocId = doc.id;
  el.diskBannerText.textContent = `${doc.name} changed on disk, and this tab has unsaved edits.`;
  el.diskBanner.hidden = false;
}

function hideDiskBanner(): void {
  conflictDocId = null;
  el.diskBanner.hidden = true;
}

/** Re-reads a document another program wrote, keeping the caret where it was. */
async function reloadDoc(doc: Doc): Promise<void> {
  if (!doc.path) return;
  try {
    const payload = await invoke<DocPayload>("read_document", { path: doc.path });
    doc.eol = payload.eol === "\r\n" ? "\r\n" : "\n";
    doc.bom = payload.bom;
    doc.savedContent = payload.content;
    doc.conflict = false;
    doc.stamp = await stampOf(doc.path);

    if (doc === activeDoc()) {
      const caret = Math.min(env.view.state.selection.main.head, payload.content.length);
      env.view.dispatch({
        changes: { from: 0, to: env.view.state.doc.length, insert: payload.content },
        selection: { anchor: caret },
      });
      scheduleRender(true);
      updateTitle();
      renderBreadcrumb();
    } else if (doc.state) {
      doc.state = createState(payload.content, env.extensions);
    }

    hideDiskBanner();
    renderTabs();
    updateStatus();
    showSaveState("Reloaded from disk");
  } catch (err) {
    showSaveState("Reload failed", true);
    await message(String(err), { title: `Could not reload ${doc.name}`, kind: "error" });
  }
}

async function checkDisk(doc: Doc): Promise<void> {
  if (!doc.path || doc.conflict) return;
  const stamp = await stampOf(doc.path);
  if (stamp === null) return;
  if (doc.stamp === null) {
    doc.stamp = stamp;
    return;
  }
  if (stamp === doc.stamp) return;

  doc.stamp = stamp;
  // A clean buffer has nothing to lose: follow the file. A dirty one is a decision for
  // the user, so the banner waits instead of quietly discarding their edits.
  if (!isDirty(doc)) {
    await reloadDoc(doc);
    return;
  }

  doc.conflict = true;
  renderTabs();
  if (doc === activeDoc()) showDiskBanner(doc);
}

async function pollDisk(): Promise<void> {
  const open = docs.filter((doc) => doc.path !== null && !doc.conflict);
  if (open.length === 0) return;
  await Promise.all(open.map((doc) => checkDisk(doc)));
}

function startDiskWatch(): void {
  window.clearInterval(diskTimer);
  diskTimer = window.setInterval(() => void pollDisk(), DISK_POLL_MS);
}

/* -------------------------------------------------------------- html export */

async function exportHtmlDoc(): Promise<void> {
  const doc = activeDoc();
  if (!doc) return;
  try {
    const written = await exportDocHtml(doc, contentOf(doc));
    if (written) showSaveState("Exported HTML");
  } catch (err) {
    await message(String(err), { title: "Could not export HTML", kind: "error" });
  }
}

/* --------------------------------------------------------------------- theme */

async function applyTheme(path: string | null): Promise<void> {
  if (!path) {
    clearCustomCss();
    refreshThemedRendering();
    return;
  }
  const failure = await applyCustomCss(path);
  if (failure) {
    await message(`The theme could not be loaded:\n\n${failure}`, {
      title: "Custom CSS unavailable",
      kind: "warning",
    });
    return;
  }
  refreshThemedRendering();
}

/**
 * Mermaid bakes the palette into each SVG, so diagrams made under the previous theme would
 * keep its colours. Redrawing them means rebuilding the pane they live in; the Markdown is
 * the source of truth, so that costs nothing but a re-render.
 */
function refreshThemedRendering(): void {
  if (!activeDoc() || mode === "raw") return;
  destroyWysiwyg();
  scheduleRender(true);
}

async function closeDoc(index: number): Promise<void> {
  const doc = docs[index];
  if (!doc) return;

  if (isDirty(doc)) {
    const discard = await ask(`"${doc.name}" has unsaved changes. Close it without saving?`, {
      title: "Unsaved changes",
      kind: "warning",
      okLabel: "Close without saving",
      cancelLabel: "Cancel",
    });
    if (!discard) return;
  }

  const wasActive = index === activeIndex;
  docs.splice(index, 1);

  if (docs.length === 0) {
    activeIndex = -1;
    newDoc();
    return;
  }

  if (wasActive) {
    const target = Math.min(index, docs.length - 1);
    activeIndex = -1;
    activate(target);
  } else {
    if (index < activeIndex) activeIndex -= 1;
    renderTabs();
    scheduleSessionSave();
  }
}

async function openFileDialog(): Promise<void> {
  const chosen = await openDialog({
    title: "Open Markdown file",
    multiple: false,
    directory: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] }],
  });
  if (typeof chosen === "string") await openPath(chosen);
}

async function openFolderDialog(): Promise<void> {
  const chosen = await openDialog({ title: "Open folder", directory: true, multiple: false });
  if (typeof chosen === "string") await openFolder(chosen);
}

async function openFolder(path: string): Promise<void> {
  try {
    await sidebar.open(path);
    setSidebarVisible(true);
    await sidebar.reveal(activeDoc()?.path ?? null);
    persist();
  } catch (err) {
    await message(String(err), { title: `Could not open ${baseName(path)}`, kind: "error" });
  }
}

/**
 * Keeps the folder tree pointed at the focused document. A file opened ad hoc, or one
 * outside the current tree, re-roots the tree at its own folder; then the path is
 * expanded, highlighted and scrolled into view.
 */
async function trackInSidebar(path: string | null): Promise<void> {
  if (!path) return;

  const root = sidebar.getRoot();

  if (!root) {
    try {
      await sidebar.open(prefs.homeFolder ?? dirName(path));
    } catch {
      // A folder that cannot be listed must not stop the document from opening.
    }
    await sidebar.reveal(path);
    return;
  }

  if (isUnderRoot(root, path)) {
    await sidebar.reveal(path);
    return;
  }

  // A configured home folder is an anchor. Opening a file from elsewhere still shows it
  // in a tab, but silently re-rooting the tree would undo the folder the user chose; the
  // breadcrumb's folder buttons and Open Folder remain the explicit way to move it.
  if (prefs.homeFolder) return;

  try {
    await sidebar.open(dirName(path));
  } catch {
    // A folder that cannot be listed must not stop the document from opening.
  }
  await sidebar.reveal(path);
}

function setSidebarVisible(visible: boolean): void {
  sidebarVisible = visible;
  el.sidebar.hidden = !visible;
  el.resizer.hidden = !visible;
  document.body.classList.toggle("sidebar-visible", visible);
  syncToolbar();
  scheduleSessionSave();
}

function toggleSidebar(): void {
  setSidebarVisible(!sidebarVisible);
}

function setMode(next: ViewMode): void {
  mode = next;
  document.body.dataset.mode = next;
  updateStatus();
  if (next === "raw") {
    destroyWysiwyg();
    env.view.focus();
  } else {
    scheduleRender(true);
  }
  syncToolbar();
  scheduleSessionSave();
}

/** Scales the editor and preview text only; chrome keeps its fixed size. */
function applyZoom(): void {
  document.documentElement.style.setProperty("--text-scale", String(zoom));
}

function setZoom(next: number): void {
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 100) / 100));
  if (clamped === zoom) return;
  zoom = clamped;
  applyZoom();
  scheduleSessionSave();
}

function cycleMode(): void {
  setMode(mode === "raw" ? "split" : mode === "split" ? "preview" : "raw");
}

/* -------------------------------------------------------------- preferences */

function chosenMode(): ViewMode {
  const checked = document.querySelector<HTMLInputElement>('input[name="prefs-mode"]:checked');
  const value = checked?.value;
  return value === "raw" || value === "preview" ? value : "split";
}

function setPrefMode(next: ViewMode): void {
  document.querySelectorAll<HTMLInputElement>('input[name="prefs-mode"]').forEach((radio) => {
    radio.checked = radio.value === next;
  });
}

function openPreferences(): void {
  // The dialog edits a draft so Cancel leaves the live settings untouched.
  prefsHomeDraft = prefs.homeFolder;
  el.prefsHome.value = prefsHomeDraft ?? "";
  setPrefMode(prefs.defaultMode);
  el.prefsSidebar.checked = prefs.sidebarVisible;
  el.prefsAutosave.checked = prefs.autosave;
  prefsCssDraft = prefs.customCss;
  el.prefsCss.value = prefsCssDraft ?? "";
  el.prefsBackdrop.hidden = false;
  // `inert` keeps Tab and screen readers inside the dialog without a hand-rolled trap.
  el.shell.inert = true;
  prefsOpen = true;
  el.prefsBrowse.focus();
}

function closePreferences(): void {
  if (!prefsOpen) return;
  prefsOpen = false;
  el.prefsBackdrop.hidden = true;
  el.shell.inert = false;
  env?.view.focus();
}

async function savePreferences(): Promise<void> {
  const home = prefsHomeDraft?.trim() ? prefsHomeDraft.trim() : null;

  // A folder that no longer exists would otherwise fail on every launch, silently.
  if (home) {
    try {
      await invoke("list_folder", { path: home });
    } catch (err) {
      await message(`That folder could not be read:\n\n${String(err)}`, {
        title: "Home folder not usable",
        kind: "error",
      });
      return;
    }
  }

  prefs = {
    homeFolder: home,
    defaultMode: chosenMode(),
    sidebarVisible: el.prefsSidebar.checked,
    autosave: el.prefsAutosave.checked,
    customCss: prefsCssDraft,
  };
  savePrefs(prefs);
  await applyTheme(prefs.customCss);
  scheduleAutosave();

  setMode(prefs.defaultMode);

  if (home) {
    try {
      await sidebar.open(home);
      await sidebar.reveal(activeDoc()?.path ?? null);
    } catch (err) {
      // Validated above, so this is a race - but silently leaving the old tree on screen
      // is exactly what makes the setting look ignored, so say what happened.
      await message(`The home folder could not be opened:\n\n${String(err)}`, {
        title: "Home folder unavailable",
        kind: "warning",
      });
    }
  } else if (sidebar.getRoot()) {
    // Clearing the home folder keeps the open tree, refreshed in case it changed on disk.
    await sidebar.reload();
  }

  // An empty sidebar reads as a rendering bug, so the setting only applies to a real tree.
  setSidebarVisible(prefs.sidebarVisible && sidebar.getRoot() !== null);

  closePreferences();
  persist();
}

function installPreferences(): void {
  el.prefsBrowse.addEventListener("click", () => {
    void (async () => {
      const chosen = await openDialog({
        title: "Choose home folder",
        directory: true,
        multiple: false,
        defaultPath: prefsHomeDraft ?? undefined,
      });
      if (typeof chosen !== "string") return;
      prefsHomeDraft = chosen;
      el.prefsHome.value = chosen;
    })();
  });

  el.prefsClear.addEventListener("click", () => {
    prefsHomeDraft = null;
    el.prefsHome.value = "";
  });

  el.prefsCssBrowse.addEventListener("click", () => {
    void (async () => {
      const chosen = await openDialog({
        title: "Choose a CSS theme",
        directory: false,
        multiple: false,
        defaultPath: prefsCssDraft ?? undefined,
        filters: [{ name: "Stylesheet", extensions: ["css"] }],
      });
      if (typeof chosen !== "string") return;
      prefsCssDraft = chosen;
      el.prefsCss.value = chosen;
    })();
  });

  el.prefsCssClear.addEventListener("click", () => {
    prefsCssDraft = null;
    el.prefsCss.value = "";
  });

  el.prefsCancel.addEventListener("click", closePreferences);
  el.prefsSave.addEventListener("click", () => void savePreferences());

  // Clicking the dimmed area dismisses, the way a native sheet does.
  el.prefsBackdrop.addEventListener("mousedown", (event) => {
    if (event.target === el.prefsBackdrop) closePreferences();
  });
}

/* ------------------------------------------------------------------ actions */

let lastAction = "";
let lastActionAt = 0;

function runAction(id: string): void {
  // The preferences sheet is modal: menu accelerators must not reach the document behind it.
  if (prefsOpen && id !== "preferences") return;
  const now = performance.now();
  if (id === lastAction && now - lastActionAt < 250) return;
  lastAction = id;
  lastActionAt = now;

  switch (id) {
    case "new":
      newDoc();
      break;
    case "open":
      void openFileDialog();
      break;
    case "open-folder":
      void openFolderDialog();
      break;
    case "save":
      void saveDoc(false);
      break;
    case "save-as":
      void saveDoc(true);
      break;
    case "export-html":
      void exportHtmlDoc();
      break;
    case "close":
      void closeDoc(activeIndex);
      break;
    case "print":
      window.print();
      break;
    case "zoom-in":
      setZoom(zoom + ZOOM_STEP);
      break;
    case "zoom-out":
      setZoom(zoom - ZOOM_STEP);
      break;
    case "zoom-reset":
      setZoom(1);
      break;
    case "exit":
      void quit();
      break;
    case "undo":
      undo(env.view);
      break;
    case "redo":
      redo(env.view);
      break;
    case "find":
      openFindPanel(env.view);
      break;
    case "bold":
      wrapSelection(env.view, "**", "**", "bold text");
      break;
    case "italic":
      wrapSelection(env.view, "*", "*", "italic text");
      break;
    case "link":
      wrapSelection(env.view, "[", "](https://)", "link text");
      break;
    case "h1":
      setHeading(env.view, 1);
      break;
    case "h2":
      setHeading(env.view, 2);
      break;
    case "h3":
      setHeading(env.view, 3);
      break;
    case "h4":
      setHeading(env.view, 4);
      break;
    case "code-block":
      insertCodeBlock(env.view);
      break;
    case "table":
      insertTable(env.view);
      break;
    case "bullet-list":
      toggleBulletList(env.view);
      break;
    case "ordered-list":
      toggleOrderedList(env.view);
      break;
    case "task-list":
      toggleTaskList(env.view);
      break;
    case "blockquote":
      toggleBlockquote(env.view);
      break;
    case "inline-code":
      toggleInlineCode(env.view);
      break;
    case "strikethrough":
      toggleStrikethrough(env.view);
      break;
    case "horizontal-rule":
      insertHorizontalRule(env.view);
      break;
    case "mode-raw":
      setMode("raw");
      break;
    case "mode-split":
      setMode("split");
      break;
    case "mode-preview":
      setMode("preview");
      break;
    case "mode-cycle":
      cycleMode();
      break;
    case "toggle-pane-view":
      setPaneView(paneView === "preview" ? "rendered" : "preview");
      break;
    case "toggle-sidebar":
      toggleSidebar();
      break;
    case "reload-folders":
      void sidebar.reload();
      break;
    case "preferences":
      openPreferences();
      break;
    case "about":
      void showAbout();
      break;
    case "shortcuts":
      void showShortcuts();
      break;
    default:
      break;
  }
}

async function quit(): Promise<void> {
  if (hasUnsaved()) {
    const discard = await ask("You have unsaved changes. Close Markdown Studio without saving?", {
      title: "Unsaved changes",
      kind: "warning",
      okLabel: "Close without saving",
      cancelLabel: "Cancel",
    });
    if (!discard) return;
  }
  flushAutosave();
  persist();
  await appWindow.destroy();
}

async function showAbout(): Promise<void> {
  const info = await invoke<{ name: string; version: string }>("app_info");
  await message(
    [
      `${info.name} ${info.version}`,
      "",
      "A lightweight Markdown editor for Windows.",
      "",
      "Editing: CodeMirror 6",
      "Rendering: markdown-it, sanitized with DOMPurify",
      "Shell: Tauri 2 (WebView2)",
      "",
      "Built with Freebuff (https://freebuff.com).",
      "With thanks to the Freebuff team for making this possible.",
    ].join("\n"),
    { title: "About Markdown Studio", kind: "info" },
  );
}

async function showShortcuts(): Promise<void> {
  const text = [
    "File",
    "  Ctrl+N          New",
    "  Ctrl+O          Open file",
    "  Ctrl+Shift+O    Open folder",
    "  Ctrl+S          Save",
    "  Ctrl+Shift+S    Save as",
    "  Ctrl+W          Close tab",
    "  Ctrl+Shift+E    Export standalone HTML",
    "  Ctrl+P          Print / export PDF",
    "  Ctrl+,          Preferences",
    "",
    "View",
    "  Ctrl+E          Cycle Raw / Split / Preview",
    "  Ctrl+1          Raw",
    "  Ctrl+2          Split",
    "  Ctrl+3          Preview",
    "  Ctrl+Alt+P      Rendered pane: read-only preview / back",
    "  Ctrl+Shift+B    Toggle folder sidebar",
    "  Ctrl+Shift+F5   Reload folder tree",
    "  Ctrl+=          Zoom in (editor and preview)",
    "  Ctrl+-          Zoom out",
    "  Ctrl+0          Reset zoom",
    "",
    "Editing",
    "  Ctrl+F          Find",
    "  Ctrl+B          Bold",
    "  Ctrl+I          Italic",
    "  Ctrl+K          Link",
    "  Ctrl+Alt+1..4   Heading 1 to 4",
    "  Ctrl+Alt+C      Code block",
    "  Ctrl+Alt+T      Table",
    "  Ctrl+Shift+L    Bulleted list",
    "  Ctrl+Shift+N    Numbered list",
    "  Ctrl+Shift+T    Task list",
    "  Ctrl+Shift+Q    Blockquote",
    "  Ctrl+Shift+C    Inline code",
    "  Ctrl+Shift+X    Strikethrough",
  ].join("\n");
  await message(text, { title: "Keyboard shortcuts", kind: "info" });
}

/* ----------------------------------------------------------------- bootstrap */

const KEY_ACTIONS: Record<string, string> = {
  "ctrl+n": "new",
  "ctrl+o": "open",
  "ctrl+shift+o": "open-folder",
  "ctrl+s": "save",
  "ctrl+shift+s": "save-as",
  "ctrl+shift+e": "export-html",
  "ctrl+w": "close",
  "ctrl+p": "print",
  "ctrl+,": "preferences",
  "ctrl+f": "find",
  "ctrl+b": "bold",
  "ctrl+i": "italic",
  "ctrl+k": "link",
  "ctrl+e": "mode-cycle",
  "ctrl+1": "mode-raw",
  "ctrl+2": "mode-split",
  "ctrl+3": "mode-preview",
  "ctrl+alt+p": "toggle-pane-view",
  "ctrl+shift+b": "toggle-sidebar",
  "ctrl+alt+1": "h1",
  "ctrl+alt+2": "h2",
  "ctrl+alt+3": "h3",
  "ctrl+alt+4": "h4",
  "ctrl+alt+c": "code-block",
  "ctrl+alt+t": "table",
  "ctrl+shift+l": "bullet-list",
  "ctrl+shift+n": "ordered-list",
  "ctrl+shift+t": "task-list",
  "ctrl+shift+q": "blockquote",
  "ctrl+shift+c": "inline-code",
  "ctrl+shift+x": "strikethrough",
};

function installKeyboardFallback(): void {
  window.addEventListener("keydown", (event) => {
    // While the sheet is open only Escape means anything; the rest would edit the
    // document it is covering.
    if (prefsOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        closePreferences();
      }
      return;
    }

    const parts: string[] = [];
    if (event.ctrlKey) parts.push("ctrl");
    if (event.shiftKey) parts.push("shift");
    if (event.altKey) parts.push("alt");
    const key = event.key.toLowerCase();
    if (key !== "control" && key !== "shift" && key !== "alt") parts.push(key);
    // Zoom needs both the shifted and unshifted forms of the + and - keys, which the
    // combo string cannot express cleanly (Ctrl+Shift+= arrives as key "+").
    if (event.ctrlKey && !event.altKey) {
      const zoomAction =
        event.key === "=" || event.key === "+"
          ? "zoom-in"
          : event.key === "-" || event.key === "_"
            ? "zoom-out"
            : event.key === "0"
              ? "zoom-reset"
              : "";
      if (zoomAction) {
        event.preventDefault();
        runAction(zoomAction);
        return;
      }
    }

    const combo = parts.join("+");
    const action = KEY_ACTIONS[combo];
    if (!action) return;
    event.preventDefault();
    runAction(action);
  });
}

function installToolbar(): void {
  // Keep editor focus (and the caret) when a ribbon button is pressed.
  el.toolbar.addEventListener("mousedown", (event) => {
    if ((event.target as HTMLElement | null)?.closest("[data-action]")) event.preventDefault();
  });
  el.toolbar.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-action]");
    if (!button?.dataset.action) return;
    runAction(button.dataset.action);
  });
}

function syncToolbar(): void {
  el.toolbar.querySelectorAll<HTMLElement>("[data-toggle='mode']").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.action === `mode-${mode}`));
  });
  el.toolbar.querySelectorAll<HTMLElement>("[data-toggle='sidebar']").forEach((button) => {
    button.setAttribute("aria-pressed", String(sidebarVisible));
  });
}

function installSidebarResizer(): void {
  let dragging = false;
  el.resizer.addEventListener("pointerdown", (event) => {
    dragging = true;
    el.resizer.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing");
  });
  el.resizer.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const width = clampWidth(event.clientX - el.sidebar.getBoundingClientRect().left);
    sidebarWidth = width;
    document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
  });
  el.resizer.addEventListener("pointerup", (event) => {
    if (!dragging) return;
    dragging = false;
    el.resizer.releasePointerCapture(event.pointerId);
    document.body.classList.remove("resizing");
    scheduleSessionSave();
  });
}

async function installDragDrop(): Promise<void> {
  await appWindow.onDragDropEvent((event) => {
    if (event.payload.type === "over" || event.payload.type === "enter") {
      el.dropOverlay.hidden = false;
      return;
    }
    el.dropOverlay.hidden = true;
    if (event.payload.type !== "drop") return;
    for (const path of event.payload.paths) {
      if (isMarkdownPath(path)) void openPath(path);
      else void openFolder(path);
    }
  });
}

async function installCloseGuard(): Promise<void> {
  await appWindow.onCloseRequested(async (event) => {
    flushAutosave();
    if (!hasUnsaved()) {
      persist();
      return;
    }
    event.preventDefault();
    const discard = await ask("You have unsaved changes. Close Markdown Studio without saving?", {
      title: "Unsaved changes",
      kind: "warning",
      okLabel: "Close without saving",
      cancelLabel: "Cancel",
    });
    if (discard) {
      persist();
      await appWindow.destroy();
    }
  });
}

function installMenuBridge(): void {
  void listen<string>("menu", (event) => runAction(event.payload));
  void listen<string[]>("single-instance-open", (event) => {
    for (const arg of event.payload) {
      if (isMarkdownPath(arg)) void openPath(arg);
    }
  });
}

export async function initApp(): Promise<void> {
  const session = loadSession();
  prefs = loadPrefs();
  // Until the dialog has been saved once, the last session's view wins, so upgrading
  // does not silently change how the app opens.
  const prefsConfigured = hasPrefs();
  mode = prefsConfigured ? prefs.defaultMode : session.mode;
  recent = session.recent;
  sidebarWidth = session.sidebar.width;
  zoom = clampZoom(session.zoom);
  document.body.dataset.mode = mode;
  paneView = session.paneView;
  document.body.dataset.pane = paneView;
  renderPaneBar();
  document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
  applyZoom();
  await applyTheme(prefs.customCss);

  env = createEditor(el.editorHost, {
    onDocChanged: () => {
      // A preview edit already owns the rendered document; re-rendering would reset it.
      if (!editingPreview) scheduleRender();
      updateTitle();
      renderTabs();
      updateStatus();
      scheduleSessionSave();
      scheduleAutosave();
    },
    onSelectionChanged: () => updateStatus(),
  });

  env.view.scrollDOM.addEventListener("scroll", onEditorScroll, { passive: true });
  el.previewScroll.addEventListener("scroll", onPreviewScroll, { passive: true });
  el.paneToggle.addEventListener("click", () => {
    setPaneView(paneView === "preview" ? "rendered" : "preview");
  });

  el.preview.addEventListener("click", (event) => {
    const anchor = (event.target as HTMLElement | null)?.closest("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (!href) return;
    event.preventDefault();
    const doc = activeDoc();
    if (/^(https?:|mailto:)/i.test(href)) {
      void invoke("open_external", { url: href }).catch((err: unknown) => {
        void message(String(err), { title: "Blocked link", kind: "warning" });
      });
      return;
    }
    if (href.startsWith("#")) {
      const target = el.preview.querySelector(`[id="${CSS.escape(href.slice(1))}"]`);
      target?.scrollIntoView({ block: "start", behavior: "smooth" });
      return;
    }
    if (doc?.dir && isMarkdownPath(href)) void openResolved(doc.dir, href);
  });

  document.getElementById("sidebar-close")?.addEventListener("click", () => setSidebarVisible(false));

  el.diskReload.addEventListener("click", () => {
    const doc = activeDoc();
    if (doc) void reloadDoc(doc);
    else hideDiskBanner();
  });
  el.diskKeep.addEventListener("click", () => {
    const doc = activeDoc();
    // Keeping the buffer means the next autosave is allowed to overwrite the file.
    if (doc) doc.conflict = false;
    hideDiskBanner();
  });
  window.addEventListener("blur", flushAutosave);

  installToolbar();
  installPreferences();
  installSidebarResizer();
  installKeyboardFallback();
  installMenuBridge();
  await installDragDrop();
  await installCloseGuard();

  const startupRoot = prefsConfigured && prefs.homeFolder ? prefs.homeFolder : session.sidebar.root;
  const startupSidebar = prefsConfigured ? prefs.sidebarVisible : session.sidebar.visible;
  if (startupRoot) {
    try {
      await sidebar.open(startupRoot);
      if (startupSidebar) setSidebarVisible(true);
    } catch (err) {
      // A home folder that has been moved or deleted must not block startup.
      if (prefsConfigured && prefs.homeFolder) {
        await message(`The home folder could not be opened:\n\n${String(err)}`, {
          title: "Home folder unavailable",
          kind: "warning",
        });
      }
    }
  }

  // Files handed to us by the shell ("Open with" or a command-line argument).
  let shellFile: string | null = null;
  try {
    const args = await invoke<string[]>("initial_args");
    for (const arg of args) {
      await openPath(arg);
      shellFile = arg;
    }
  } catch {
    // Not fatal: the window simply opens empty.
  }

  for (const path of session.tabs) {
    if (!docs.some((doc) => doc.path !== null && samePath(doc.path, path))) {
      await openPath(path);
    }
  }

  // A file handed to us by the shell wins over the restored session tab: otherwise
  // double-clicking a file in Explorer looks like the app opened the wrong document.
  const requestedPath: string | null = shellFile;
  const requestedIndex =
    requestedPath === null
      ? -1
      : docs.findIndex((doc) => doc.path !== null && samePath(doc.path, requestedPath));

  if (docs.length === 0) newDoc();
  else if (requestedIndex >= 0) activate(requestedIndex);
  else activate(Math.min(Math.max(session.activeIndex, 0), docs.length - 1));

  renderTabs();
  updateTitle();
  renderBreadcrumb();
  updateStatus();
  startDiskWatch();
  syncToolbar();
}

export function bootError(err: unknown): void {
  const text = err instanceof Error ? `${err.message}\n\n${err.stack ?? ""}` : String(err);
  document.body.innerHTML = `<pre style="padding:24px;font:13px/1.5 Consolas,monospace;white-space:pre-wrap">Could not start Markdown Studio.\n\n${text.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c)}</pre>`;
}
