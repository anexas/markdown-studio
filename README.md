# Markdown Studio

A lightweight Markdown editor for Windows 11: raw source on one side, rendered HTML on
the other, built with Tauri 2 (WebView2) so the installer stays small and no Chromium
is bundled.

Version 0.9.1 — per-machine MSI, registered as the default handler for `.md`.

## Features

- **Three view modes** — Raw (CodeMirror 6 with Markdown syntax highlighting), Split
  (source + editable rendered pane, synchronized scrolling) and Preview (read-only).
  `Ctrl+E` cycles them.
- **Editable rendered pane** — the pane on the right in Split accepts typing: block elements render
  as you edit, `Enter` continues a list, `Tab` nests it, `Ctrl+B`/`Ctrl+I` toggle bold and
  italic, and task checkboxes are clickable. Every keystroke is serialized back into the
  source buffer, which remains the file's single source of truth. Markdown the editor
  cannot model — tables, raw HTML blocks — is preserved exactly and shown as a raw block
  instead of being rewritten; formatting elsewhere is normalized (`*em*` becomes `_em_`). A slim
  header on that pane toggles it to the read-only preview and back — the button in that
  header (a pencil while editable, an eye once read-only, labelled accordingly in the pane
  header), `Ctrl+Alt+P`, or View → Preview in rendered pane — and the choice sticks for the
  session.
  Preview is the faithful read-only render — tables, raw HTML and footnotes look there
  exactly as they will print.
- **GFM rendering** — tables, task lists, footnotes, heading anchors, autolinks,
  fenced code with language highlighting.
- **Tabs** that are always visible, including the empty startup buffer, with dirty
  markers, middle-click close and session restore on relaunch. `Ctrl+N` reuses an
  untouched empty buffer instead of stacking identical Untitled tabs.
- **Icon ribbon** under the menu bar — new/open/save, undo/redo, bold/italic/link,
  headings H1–H4, code block, table, bulleted/numbered/task lists, blockquote, inline
  code, strikethrough, horizontal rule, the three view modes, sidebar, find, print and
  text zoom. Every button maps to the same command id as its menu item.
- **Block editing** — lists, blockquote, inline code and strikethrough are toggles: they
  add their markers to every selected line, remove them when the whole selection already
  has them, and convert between list types instead of stacking markers. Numbered lists
  renumber across the selection, and empty filler lines inside a multi-line selection are
  left alone so a list does not gain stray bullets.
- **Folder sidebar** — lazily expanded, read-only tree of Markdown files, resizable.
  It follows the focused document: opening a file re-roots the tree at that file's
  folder if needed, expands the path, highlights the row and scrolls it into view.
  A `..` row at the top steps one level up; drive roots and network share roots show no
  row, since there is nothing useful above them to list.
- **Breadcrumb bar** under the tabs — each folder segment is a button that opens that
  folder in the sidebar; untitled buffers show a muted placeholder instead.
- **Text zoom** — 60 %–240 % in 10 % steps, applied to the editor and rendered pane only so
  the chrome never reflows. Remembered between sessions; printing stays at normal size.
- **Preferences** (`Ctrl+,`) — choose the home folder the sidebar opens with, the
  default view mode, and whether the folder sidebar starts visible. Preferences are
  starting defaults only: until you save them once, the app keeps restoring the view
  and folder you were last using. The tree stays rooted at the home folder — opening a
  file from elsewhere shows it in a tab without moving the tree away.
- **Native Windows shell** — real Win32 menu bar with accelerators, native file dialogs,
  drag-and-drop, single instance, remembered window geometry. A file passed by the shell
  ("Open with", command line) wins focus over the restored session tab.

## Keyboard shortcuts

| Command | Shortcut |
| --- | --- |
| New / Open / Open folder | `Ctrl+N` · `Ctrl+O` · `Ctrl+Shift+O` |
| Save / Save as | `Ctrl+S` · `Ctrl+Shift+S` |
| Close tab / Print or export PDF | `Ctrl+W` · `Ctrl+P` |
| Preferences | `Ctrl+,` |
| Cycle view · Raw · Split · Preview | `Ctrl+E` · `Ctrl+1` · `Ctrl+2` · `Ctrl+3` |
| Rendered pane · read-only preview | `Ctrl+Alt+P` |
| Folder sidebar / Reload folder tree | `Ctrl+Shift+B` · `Ctrl+Shift+F5` |
| Zoom in / out / reset | `Ctrl+=` · `Ctrl+-` · `Ctrl+0` |
| Find | `Ctrl+F` |
| Bold / Italic / Link | `Ctrl+B` · `Ctrl+I` · `Ctrl+K` |
| Heading 1–4 | `Ctrl+Alt+1` … `Ctrl+Alt+4` |
| Code block / Table | `Ctrl+Alt+C` · `Ctrl+Alt+T` |
| Bulleted / Numbered / Task list | `Ctrl+Shift+L` · `Ctrl+Shift+N` · `Ctrl+Shift+T` |
| Blockquote / Inline code / Strikethrough | `Ctrl+Shift+Q` · `Ctrl+Shift+C` · `Ctrl+Shift+X` |
| Horizontal rule | Edit menu or ribbon |

Heading commands replace an existing `#` prefix rather than stacking hashes, so they
also convert a heading from one level to another, and they keep the caret at the same
offset inside the text.

## Security model

Markdown is treated as untrusted input:

- Rendered HTML is sanitized with DOMPurify before insertion.
- Strict CSP: no remote scripts, styles, or images; no frames; no eval.
- No filesystem, shell, or HTTP plugins are exposed to the frontend. A handful of Rust
  commands (`read_document`, `write_document`, `list_folder`, `read_image`,
  `open_external`) perform all file access with extension, size, and path validation.
- Saves are atomic: written to a temporary file in the same directory, flushed, then
  renamed over the target.
- Images must be raster (PNG/JPEG/GIF/WebP/BMP), under 10 MB. **SVG is refused** because
  it can execute script inside the webview. Remote images are blocked and shown as a
  placeholder rather than silently loaded.

## Encodings

Files are read as UTF-8 (with or without BOM) and written back with the same BOM state
and the same line endings (LF or CRLF) they were opened with. UTF-16 and legacy code
pages are not supported; the status bar always reports what was detected.

## Build

Prerequisites: Node.js 22+, Rust (stable, MSVC toolchain) and Visual Studio Build Tools
2022 with the C++ workload.

```bash
npm install
npm run dev          # frontend only, in a browser at http://localhost:1420
npm run tauri dev    # the real desktop app with hot reload
npm run tauri build -- --bundles msi
```

The MSI lands in `src-tauri/target/release/bundle/msi/`. It installs per-machine to
Program Files and registers `.md`, `.markdown`, `.mdown` and `.mkd`.

Bump the version in `package.json`, `src-tauri/Cargo.toml` and
`src-tauri/tauri.conf.json` together before building a release: Windows Installer skips
replacing a binary whose file version has not changed.

## Layout

| Path | Purpose |
| --- | --- |
| `index.html` | Shell markup: ribbon, tab strip, breadcrumb, panes, status bar |
| `src/app.ts` | Tabs, documents, commands, zoom, breadcrumb, drag-drop, session |
| `src/editor.ts` | CodeMirror 6 environment, themes and editing commands |
| `src/render.ts` | markdown-it → DOMPurify pipeline, image hydration |
| `src/wysiwyg.ts` | Editable rendered pane: schema, markdown parse/serialize, node views |
| `src/sidebar.ts` | Lazy folder tree, reveal/expand tracking |
| `src/session.ts` | localStorage session (tabs, mode, sidebar, zoom, recents) |
| `src/prefs.ts` | Startup defaults (home folder, view mode, sidebar) |
| `src/styles/app.css` | Application chrome, panes, print stylesheet |
| `src-tauri/src/commands.rs` | Validated file system commands |
| `src-tauri/src/menu.rs` | Native menu bar |
| `src-tauri/src/lib.rs` | Window setup, menu wiring, single instance |

## Credits

Built with [Freebuff](https://freebuff.com) — with thanks to the Freebuff team.

Standing on the shoulders of [Tauri](https://tauri.app),
[CodeMirror](https://codemirror.net), [markdown-it](https://github.com/markdown-it/markdown-it),
[DOMPurify](https://github.com/cure53/DOMPurify) and
[highlight.js](https://highlightjs.org).

## Licence

Released under the MIT licence — see [LICENSE](LICENSE) for the full text.

## Third-party notices

The application bundles third-party libraries whose licences require their notices to
travel with it — CodeMirror, markdown-it, DOMPurify, highlight.js and their transitive
dependencies, plus the Rust crates linked into the executable. The full list and licence
texts are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
