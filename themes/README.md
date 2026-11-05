# Theme files

Four ready-to-use stylesheets for **Preferences → Custom CSS theme**, plus the
notes needed to write your own. They live outside `src/`, so nothing here is
bundled into the app: edit a file and re-apply it, and the running editor picks
it up without a rebuild.

| File | Look | Teaches |
| --- | --- | --- |
| `paper.css` | Warm cream, serif | Forcing a light look; retoning code and type |
| `midnight.css` | Dark slate, cool accents | Forcing dark; why `.hljs` must be restated |
| `high-contrast.css` | Black on white, heavier rules | Changing weight, borders and text size |
| `duotone.css` | Off-white / deep navy | Following the Windows light/dark setting |

## Applying one

1. `Ctrl+,` → **Custom CSS theme** → **Browse…**
2. Pick a `.css` file from this folder → **OK**.
3. The window restyles at once. **Clear** returns to the built-in look.

The chosen path is remembered, so the theme is applied again on the next launch.
A file is read at that moment, though — editing `paper.css` afterwards needs
Browse → OK again (or a relaunch) before you see the change; nothing watches the
file. Re-picking the same file is enough.

Only `.css` files are accepted (the Rust side checks the extension and caps the
file at 512 KB), so a typo cannot pull a script in as a stylesheet.

## Which stylesheet you are fighting

Three layers decide how a document looks:

| Layer | File | Covers |
| --- | --- | --- |
| Document defaults | `github-markdown-css` (dependency) | headings, paragraphs, tables, links in both panes |
| Application chrome | `src/styles/app.css` | toolbar, tabs, sidebar, status bar, pane layout, `.hljs` code blocks |
| Export page | `src/styles/export.css` | the standalone HTML export only |

Your theme is appended **last** in the window, so equal-specificity rules win
without `!important` — but only where the selectors line up:

- **Chrome** responds to the CSS variables in `:root` (`--bg`, `--bg-chrome`,
  `--fg`, `--border`, `--accent`, …).
- **The panes do not read those variables.** GitHub's stylesheet supplies their
  colours, so document colours must be written out explicitly for
  `.markdown-body` (read-only preview and exports) and `#preview .ProseMirror`
  (the pane you type in).
- **Exports** read `--fg`, `--fg-muted`, `--bg`, `--border`, `--accent`,
  `--code-bg`, `--quote` from your `:root` block, and match `.markdown-body`
  selectors — which is why the pane rules above theme exports too.

Variable cheat sheet:

| Variable | Used by | Meaning |
| --- | --- | --- |
| `--bg` | chrome + export | window and page background |
| `--bg-chrome` | chrome | toolbar, tabs, status bar |
| `--bg-elevated` | chrome | inputs, dialogs, buttons |
| `--fg` | chrome + export | primary text |
| `--fg-muted` | chrome + export | secondary text, status bar |
| `--border` | chrome + export | rules and dividers |
| `--accent` | chrome + export | focus rings, links, save state |
| `--accent-soft` | chrome | selected tool, conflict banner |
| `--hover` | chrome | pointer hover wash |
| `--code-bg` | export | code blocks and table headers |
| `--quote` | export | blockquote text |
| `--text-scale` | panes | zoom — **read it, never set it** |

## Writing your own

Start from whichever variant is closest and change two blocks:

1. **`:root`** — the palette for chrome and exports.
2. **`.markdown-body, #preview .ProseMirror`** — the same colours for the panes,
   because they come from a different stylesheet.

Things worth knowing before you fight the cascade:

- **Dark mode is a media query, not a variable.** Both built-in sheets swap
  their palette inside `@media (prefers-color-scheme: dark)`. Since your file
  loads last, a bare `:root { --bg: #fff }` overrides dark mode too — that is
  exactly how `paper.css` forces light. `duotone.css` shows the other way:
  every colour nested in the two scheme blocks.
- **Code blocks are hard-coded.** `app.css` gives `.hljs` a light GitHub palette
  with literal hex values, not variables. A dark theme that only changes `--bg`
  leaves bright code blocks behind; restate `.hljs` and the tokens you care
  about (the `midnight.css` block is the template).
- **Keep `var(--text-scale)` if you mention font size**, e.g.
  `font-size: calc(17px * var(--text-scale))`. A fixed `px` value would break
  `Ctrl+/-` in the panes.
- **Mermaid is independent.** Diagrams are SVGs drawn by Mermaid with its own
  light palette; CSS cannot recolour them properly, so `midnight.css` leaves them
  light and documents why.
- **Print overrides everything.** `app.css` forces black-on-white for printed
  previews regardless of theme, which is deliberate.
- **`!important` is unnecessary** for equal-specificity overrides — reach for it
  only when overriding a rule that already uses it (print styles do).

## Keeping variants

Point Preferences at one file at a time; the rest just sit here. Duplicate
`paper.css` to `paper-tight.css`, change the numbers, and both stay available
for the next time you want them.
