# Theme files

Eight ready-to-use stylesheets for **Preferences → Custom CSS theme**, plus the
notes needed to write your own. They live outside `src/`, so nothing here is
bundled into the app: edit a file and re-apply it, and the running editor picks
it up without a rebuild.

| File | Look | Teaches |
| --- | --- | --- |
| `paper.css` | Warm cream, serif | Forcing a light look; retoning code and type |
| `midnight.css` | Dark slate, cool accents | Forcing dark; why `.hljs` must be restated |
| `high-contrast.css` | Black on white, heavier rules | Changing weight, borders and text size |
| `duotone.css` | Off-white / deep navy | Following the Windows light/dark setting |
| `lavender-mist.css` | Soft lilac, near-white | A pale tint carried into code and tables |
| `mint-meadow.css` | Pale green | Cool green accents on a bright page |
| `peach-sorbet.css` | Warm peach | Amber accents, soft borders |
| `sakura-bloom.css` | Rose | Pink accents with muted prose |

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
| Application chrome | `src/styles/app.css` | toolbar, tabs, sidebar, status bar, pane layout, `.hljs` code blocks, raw pane and diagram variables |
| Export page | `src/styles/export.css` | the standalone HTML export only |

Your theme is appended **last** in the window, so equal-specificity rules win
without `!important` — but only where the selectors line up:

- **Chrome** responds to the CSS variables in `:root` (`--bg`, `--bg-chrome`,
  `--fg`, `--border`, `--accent`, …).
- **The rendered panes do not read those variables.** GitHub's stylesheet
  supplies their colours, so document colours must be written out explicitly for
  `.markdown-body` (read-only preview and exports) and `#preview .ProseMirror`
  (the pane you type in).
- **The raw pane does read variables.** CodeMirror generates its class names at
  run time, which is why a theme cannot target them — but variables are
  inherited, so `--source-*` follows `--bg`, `--fg`, `--accent` and `--fg-muted`,
  and `--syntax-*` mixes each hue with `--fg` so one definition stays legible on
  cream and on near-black. Redefine those only when the source side should look
  different from the rest of the window.
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
| `--source-bg` / `--source-fg` | raw pane | source background and text (default `--bg` / `--fg`) |
| `--source-gutter-bg` / `--source-gutter-fg` | raw pane | line-number gutter |
| `--source-selection` / `--source-active-line` | raw pane | selection and current line |
| `--syntax-*` | raw pane | heading, link, keyword, string, number, name, variable, comment, meta |
| `--diagram-node-bg` | diagrams | Mermaid node fill (default `--code-bg`) |
| `--diagram-node-border` / `--diagram-line` | diagrams | Mermaid edges and arrows |
| `--diagram-text` / `--diagram-label-bg` | diagrams | labels on nodes and edges |
| `--diagram-cluster-bg` / `--diagram-accent` | diagrams | subgraph fill and pie slices |

## Writing your own

Start from whichever variant is closest and change two blocks:

1. **`:root`** — the palette for chrome, exports, the raw pane and diagrams.
2. **`.markdown-body, #preview .ProseMirror`** — the same colours for the rendered
   panes, because they come from a different stylesheet.
3. **Nothing else, usually.** `--source-*` and `--diagram-*` already follow the
   palette above; name one only to make that surface different.

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
- **Mermaid follows the palette.** Mermaid paints fills into the SVG itself, so
  no stylesheet rule can reach them. `src/render.ts` reads `--diagram-*`
  (falling back to `--code-bg` for nodes, `--border` for edges and `--fg-muted`
  for arrows) and hands those colours to Mermaid when it draws. A theme that only
  changes `--bg` and `--fg` already gets matching diagrams; use the `--diagram-*`
  names when they should differ. Applying a theme redraws the diagrams so they do
  not keep the previous palette.
- **Print overrides everything.** `app.css` forces black-on-white for printed
  previews regardless of theme, which is deliberate.
- **`!important` is unnecessary** for equal-specificity overrides — reach for it
  only when overriding a rule that already uses it (print styles do).

## Keeping variants

Point Preferences at one file at a time; the rest just sit here. Duplicate
`paper.css` to `paper-tight.css`, change the numbers, and both stay available
for the next time you want them.
