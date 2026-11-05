/**
 * Editable half of the split view.
 *
 * The markdown text in the CodeMirror buffer stays the single source of truth. This module
 * parses that text into a ProseMirror document, lets the user edit the rendered result, and
 * serializes the document straight back to markdown. Anything the schema cannot model (raw
 * HTML blocks, tables) is kept as an opaque `verbatim` block, so editing one paragraph never
 * rewrites the parts of the file the editor does not understand.
 */
import MarkdownIt from "markdown-it";
import { Schema } from "prosemirror-model";
import type { Mark, MarkSpec, Node as PmNode, NodeSpec } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { NodeViewConstructor, ViewMutationRecord } from "prosemirror-view";
import { Transform } from "prosemirror-transform";
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { liftListItem, sinkListItem, splitListItem } from "prosemirror-schema-list";
import { invoke } from "@tauri-apps/api/core";
import katex from "katex";

import { mathPlugin, renderMermaidSvg } from "./render";

/* ------------------------------------------------------------------- schema */

const nodes: { [name: string]: NodeSpec } = {
  doc: { content: "block+" },

  paragraph: {
    content: "inline*",
    group: "block",
    parseDOM: [{ tag: "p" }],
    toDOM: () => ["p", 0],
  },

  heading: {
    attrs: { level: { default: 1 } },
    content: "inline*",
    group: "block",
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
    toDOM: (node) => [`h${node.attrs.level}`, 0],
  },

  blockquote: {
    content: "block+",
    group: "block",
    defining: true,
    parseDOM: [{ tag: "blockquote" }],
    toDOM: () => ["blockquote", 0],
  },

  code_block: {
    attrs: { lang: { default: "" } },
    content: "text*",
    marks: "",
    group: "block",
    code: true,
    defining: true,
    parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
    toDOM: (node) => ["pre", { "data-lang": node.attrs.lang || null }, ["code", 0]],
  },

  horizontal_rule: {
    group: "block",
    parseDOM: [{ tag: "hr" }],
    toDOM: () => ["hr"],
  },

  /** `$tex$`. An atom: the formula is edited in the source pane, not inside the typeset box. */
  math_inline: {
    inline: true,
    group: "inline",
    atom: true,
    attrs: { tex: { default: "" } },
    toDOM: (node) => ["span", { class: "pm-math" }, String(node.attrs.tex ?? "")],
    leafText: (node) => `$${String(node.attrs.tex ?? "")}$`,
  },

  /** `$$…$$` on its own lines. */
  math_block: {
    group: "block",
    atom: true,
    attrs: { tex: { default: "" } },
    toDOM: (node) => ["div", { class: "pm-math pm-math-block" }, String(node.attrs.tex ?? "")],
    leafText: (node) => `$$\n${String(node.attrs.tex ?? "")}\n$$`,
  },

  bullet_list: {
    // `spread` records whether the source kept blank lines between items, so a loose
    // list is not silently tightened on the first edit.
    attrs: { spread: { default: false } },
    content: "list_item+",
    group: "block",
    parseDOM: [{ tag: "ul" }],
    toDOM: () => ["ul", 0],
  },

  ordered_list: {
    attrs: { start: { default: 1 }, spread: { default: false } },
    content: "list_item+",
    group: "block",
    parseDOM: [{ tag: "ol" }],
    toDOM: (node) => ["ol", { start: node.attrs.start }, 0],
  },

  list_item: {
    content: "paragraph block*",
    defining: true,
    parseDOM: [{ tag: "li" }],
    toDOM: () => ["li", 0],
  },

  /**
   * Inline checkbox. It lives inside the item's first paragraph so the text flow stays
   * natural, and the list serializer turns it back into a `- [ ] ` / `- [x] ` marker.
   */
  task_box: {
    attrs: { checked: { default: false } },
    inline: true,
    group: "inline",
    atom: true,
    selectable: false,
    toDOM: () => ["span", { class: "pm-task-box" }],
  },

  /** A newline in the source that is not a paragraph break; keeps hard-wrapped prose intact. */
  soft_break: {
    inline: true,
    group: "inline",
    atom: true,
    selectable: false,
    toDOM: () => ["span", { class: "pm-softbreak" }],
    leafText: () => " ",
  },

  hard_break: {
    inline: true,
    group: "inline",
    atom: true,
    selectable: false,
    toDOM: () => ["br"],
    leafText: () => "\n",
  },

  image: {
    inline: true,
    group: "inline",
    atom: true,
    draggable: true,
    attrs: { src: { default: "" }, alt: { default: "" }, title: { default: "" } },
    parseDOM: [{ tag: "img[src]" }],
    toDOM: (node) => ["img", { src: node.attrs.src, alt: node.attrs.alt, title: node.attrs.title }],
  },

  /** Markdown the schema cannot model, preserved byte for byte. */
  verbatim: {
    attrs: { text: { default: "" } },
    group: "block",
    atom: true,
    selectable: false,
    toDOM: (node) => ["pre", { class: "pm-verbatim" }, node.attrs.text],
    leafText: (node) => node.attrs.text,
  },

  text: { group: "inline" },
};

const marks: { [name: string]: MarkSpec } = {
  em: { parseDOM: [{ tag: "em" }, { tag: "i" }], toDOM: () => ["em", 0] },
  strong: { parseDOM: [{ tag: "strong" }, { tag: "b" }], toDOM: () => ["strong", 0] },
  strike: { parseDOM: [{ tag: "s" }, { tag: "del" }], toDOM: () => ["s", 0] },
  code: { code: true, parseDOM: [{ tag: "code" }], toDOM: () => ["code", 0] },
  link: {
    attrs: { href: { default: null }, title: { default: null } },
    inclusive: false,
    parseDOM: [{ tag: "a[href]" }],
    toDOM: (mark) => ["a", { href: mark.attrs.href, title: mark.attrs.title, rel: "noreferrer noopener" }, 0],
  },
};

const schema = new Schema({ nodes, marks });

/* ------------------------------------------------------------------- parser */

interface MdToken {
  type: string;
  tag: string;
  content: string;
  info: string;
  hidden: boolean;
  map: [number, number] | null;
  attrs: Array<[string, string]> | null;
  children: MdToken[] | null;
  attrGet(name: string): string | null;
}

const parseMd = new MarkdownIt({ html: true, linkify: false, breaks: false, typographer: false });
// Same maths rules as the preview, so `$…$` parses identically on both sides.
mathPlugin(parseMd);

/** Only link targets that cannot execute anything survive the round trip. */
function safeHref(href: string | null): string | null {
  if (!href) return null;
  const value = href.trim();
  if (!value) return null;
  if (/^(javascript|vbscript|data|file):/i.test(value)) return null;
  return value;
}

function inlineMarkdownLength(child: PmNode): number {
  if (child.isText) return (child.text ?? "").length;
  switch (child.type.name) {
    case "soft_break":
      return 1;
    case "hard_break":
      return 2;
    case "task_box":
      // Consumed by the list-item marker, so it contributes nothing to the line.
      return 0;
    case "image":
      return 4 + String(child.attrs.alt ?? "").length + String(child.attrs.src ?? "").length;
    case "math_inline":
      return 2 + String(child.attrs.tex ?? "").length;
    default:
      return 1;
  }
}

function textblockMarkdownLength(node: PmNode): number {
  let total = 0;
  for (let index = 0; index < node.childCount; index += 1) {
    total += inlineMarkdownLength(node.child(index));
  }
  return total;
}

function parseInline(children: MdToken[], fallback: string): PmNode[] {
  const out: PmNode[] = [];
  const active: Mark[] = [];

  const pushMark = (mark: Mark) => active.push(mark);
  const popMark = (type: string) => {
    const index = active.map((mark) => mark.type.name).lastIndexOf(type);
    if (index >= 0) active.splice(index, 1);
  };
  const addText = (value: string, extra?: Mark) => {
    if (!value) return;
    out.push(schema.text(value, extra ? [...active, extra] : [...active]));
  };

  for (const child of children) {
    switch (child.type) {
      case "text":
        addText(child.content);
        break;
      case "code_inline":
        addText(child.content, schema.marks.code.create());
        break;
      case "math_inline":
        out.push(schema.nodes.math_inline.create({ tex: child.content }));
        break;
      case "strong_open":
        pushMark(schema.marks.strong.create());
        break;
      case "strong_close":
        popMark("strong");
        break;
      case "em_open":
        pushMark(schema.marks.em.create());
        break;
      case "em_close":
        popMark("em");
        break;
      case "s_open":
        pushMark(schema.marks.strike.create());
        break;
      case "s_close":
        popMark("strike");
        break;
      case "link_open": {
        const href = safeHref(child.attrGet("href"));
        if (href) pushMark(schema.marks.link.create({ href, title: child.attrGet("title") }));
        break;
      }
      case "link_close":
        popMark("link");
        break;
      case "image": {
        const src = child.attrGet("src") ?? "";
        if (src) {
          out.push(
            schema.nodes.image.create({
              src,
              alt: child.content || child.attrGet("alt") || "",
              title: child.attrGet("title") ?? "",
            }),
          );
        }
        break;
      }
      case "softbreak":
        out.push(schema.nodes.soft_break.create());
        break;
      case "hardbreak":
        out.push(schema.nodes.hard_break.create());
        break;
      default:
        // html_inline and anything else without a node: keep the literal text rather
        // than silently dropping what the user wrote.
        addText(child.content);
        break;
    }
  }

  if (out.length === 0 && fallback) addText(fallback);
  return out;
}

/** Rebuilds a table's markdown when markdown-it did not give us its source lines. */
function tableFromTokens(tokens: MdToken[], from: number, to: number): string {
  const rows: string[][] = [];
  let row: string[] | null = null;

  for (let index = from; index < to; index += 1) {
    const token = tokens[index];
    if (token.type === "tr_open") row = [];
    else if (token.type === "tr_close" && row) {
      rows.push(row);
      row = null;
    } else if ((token.type === "th_open" || token.type === "td_open") && row) {
      const inline = tokens[index + 1];
      row.push(inline && inline.type === "inline" ? inline.content.replace(/\|/g, "\\|") : "");
    }
  }
  if (rows.length === 0) return "";
  const header = rows[0];
  const ruler = header.map(() => "---");
  return [header, ruler, ...rows.slice(1)]
    .map((cells) => `| ${cells.join(" | ")} |`)
    .join("\n");
}

export function parseMarkdown(source: string): PmNode {
  const tokens = parseMd.parse(source, {}) as unknown as MdToken[];
  const lines = source.split(/\r\n|\n/);
  const root: PmNode[] = [];
  const blocks: PmNode[][] = [root];
  const spread: boolean[] = [];
  const listStart: number[] = [];

  const push = (node: PmNode) => blocks[blocks.length - 1].push(node);

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    switch (token.type) {
      case "paragraph_open":
      case "heading_open": {
        const inline = tokens[i + 1];
        const content = inline && inline.type === "inline" ? parseInline(inline.children ?? [], inline.content) : [];
        // A paragraph markdown-it did not hide means its list is loose (items separated
        // by blank lines); remember that on the enclosing list.
        if (token.type === "paragraph_open" && token.hidden === false && spread.length > 0) {
          spread[spread.length - 1] = true;
        }
        const node =
          token.type === "heading_open"
            ? schema.nodes.heading.create({ level: Number(token.tag.slice(1)) || 1 }, content)
            : schema.nodes.paragraph.create(null, content);
        push(node);
        i += inline && inline.type === "inline" ? 2 : 1;
        break;
      }

      case "blockquote_open":
        blocks.push([]);
        break;
      case "blockquote_close": {
        const children = blocks.pop() ?? [];
        push(schema.nodes.blockquote.create(null, children.length ? children : [schema.nodes.paragraph.create()]));
        break;
      }

      case "bullet_list_open":
      case "ordered_list_open":
        blocks.push([]);
        spread.push(false);
        listStart.push(Number(token.attrGet("start") ?? 1));
        break;
      case "bullet_list_close":
      case "ordered_list_close": {
        const items = blocks.pop() ?? [];
        const isOrdered = token.type === "ordered_list_close";
        const isSpread = spread.pop() ?? false;
        const start = listStart.pop() ?? 1;
        push(
          isOrdered
            ? schema.nodes.ordered_list.create({ start: Number.isFinite(start) ? start : 1, spread: isSpread }, items)
            : schema.nodes.bullet_list.create({ spread: isSpread }, items),
        );
        break;
      }

      case "list_item_open":
        blocks.push([]);
        break;
      case "list_item_close": {
        const children = blocks.pop() ?? [];
        if (children.length === 0 || children[0].type.name !== "paragraph") {
          children.unshift(schema.nodes.paragraph.create());
        }
        push(schema.nodes.list_item.create(null, withTaskBox(children)));
        break;
      }

      case "fence":
        push(
          schema.nodes.code_block.create(
            { lang: (token.info ?? "").trim().split(/\s+/)[0] ?? "" },
            token.content ? schema.text(token.content.replace(/\n$/, "")) : null,
          ),
        );
        break;

      case "code_block":
        push(
          schema.nodes.code_block.create(
            { lang: "" },
            token.content ? schema.text(token.content.replace(/\n$/, "")) : null,
          ),
        );
        break;

      case "math_block":
        push(schema.nodes.math_block.create({ tex: token.content }));
        break;

      case "hr":
        push(schema.nodes.horizontal_rule.create());
        break;

      case "html_block":
        push(schema.nodes.verbatim.create({ text: token.content.trimEnd() }));
        break;

      case "table_open": {
        let close = i;
        while (close < tokens.length && tokens[close].type !== "table_close") close += 1;
        const startLine = token.map?.[0] ?? -1;
        // markdown-it gives the table opener a line map but no reliable end line, so the
        // block is measured by its own rows: every table line contains a pipe.
        let endLine = tokens[close]?.map?.[1] ?? -1;
        if (startLine >= 0 && endLine <= startLine + 1) {
          endLine = startLine;
          while (endLine < lines.length && lines[endLine].includes("|")) endLine += 1;
        }
        const exact = startLine >= 0 && endLine > startLine ? lines.slice(startLine, endLine).join("\n") : "";
        const text = exact || tableFromTokens(tokens, i, close);
        if (text) push(schema.nodes.verbatim.create({ text }));
        i = close;
        break;
      }

      default:
        break;
    }
  }

  const content = root.length ? root : [schema.nodes.paragraph.create()];
  return schema.nodes.doc.create(null, content);
}

/** Turns a leading `[ ] ` / `[x] ` into a checkbox node so task items survive editing. */
function withTaskBox(children: PmNode[]): PmNode[] {
  const first = children[0];
  if (!first || first.type.name !== "paragraph") return children;
  const head = first.firstChild;
  if (!head || !head.isText) return children;

  const match = /^\[([ xX])\]\s+/.exec(head.text ?? "");
  if (!match) return children;

  const rest = (head.text ?? "").slice(match[0].length);
  const content: PmNode[] = [schema.nodes.task_box.create({ checked: match[1].toLowerCase() === "x" })];
  if (rest) content.push(schema.text(rest, head.marks));
  // Everything after the checked text (emphasis, nested lists) belongs to the item too.
  for (let index = 1; index < first.childCount; index += 1) content.push(first.child(index));

  const paragraph = schema.nodes.paragraph.create(null, content);
  return [paragraph, ...children.slice(1)];
}

/* --------------------------------------------------------------- serializer */

function escapeInline(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]<>])/g, "\\$1")
    .split("\n")
    .map((line) => line.replace(/^(#{1,6}|[-+>])(?=\s)/, "\\$1").replace(/^(\d+)([.)])(?=\s)/, "$1\\$2"))
    .join("\n");
}

function codeSpan(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(longest + 1);
  // Padding is only needed when the content itself starts or ends with a backtick.
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Marks are emitted statefully around text runs, so nested emphasis stays valid markdown. */
const MARK_ORDER = ["link", "strong", "em", "strike"] as const;

function orderedMarks(marks: readonly Mark[]): Mark[] {
  return MARK_ORDER.map((name) => marks.find((mark) => mark.type.name === name)).filter(
    (mark): mark is Mark => Boolean(mark),
  );
}

function markKey(mark: Mark): string {
  return mark.type.name === "link" ? `link:${String(mark.attrs.href ?? "")}` : mark.type.name;
}

function markOpen(mark: Mark): string {
  switch (mark.type.name) {
    case "link":
      return "[";
    case "strong":
      return "**";
    case "em":
      return "_";
    default:
      return "~~";
  }
}

function markClose(mark: Mark): string {
  switch (mark.type.name) {
    case "link": {
      const href = String(mark.attrs.href ?? "");
      return `](${href}${mark.attrs.title ? ` "${mark.attrs.title}"` : ""})`;
    }
    case "strong":
      return "**";
    case "em":
      return "_";
    default:
      return "~~";
  }
}

function inlineNodeMarkdown(child: PmNode, skipTaskBox: boolean): string {
  switch (child.type.name) {
    case "soft_break":
      return "\n";
    case "hard_break":
      return "\\\n";
    case "image": {
      const { src, alt, title } = child.attrs as { src: string; alt: string; title: string };
      return `![${alt ?? ""}](${src}${title ? ` "${title}"` : ""})`;
    }
    case "math_inline":
      return `$${String(child.attrs.tex ?? "")}$`;
    case "task_box":
      return skipTaskBox ? "" : `[${child.attrs.checked ? "x" : " "}] `;
    default:
      return "";
  }
}

function inlineMarkdown(node: PmNode, skipTaskBox = false): string {
  let out = "";
  // Whitespace at a run boundary cannot live inside an emphasis delimiter, or the mark
  // stops parsing. It is stashed and emitted once the delimiters have been closed.
  let pending = "";
  const open: Mark[] = [];

  const flushPending = () => {
    if (pending) {
      out += pending;
      pending = "";
    }
  };
  const closeTo = (depth: number) => {
    while (open.length > depth) out += markClose(open.pop() as Mark);
  };

  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);

    if (!child.isText) {
      closeTo(0);
      flushPending();
      out += inlineNodeMarkdown(child, skipTaskBox);
      continue;
    }

    // Code is opaque: it cannot contain mark delimiters, so it closes the current run.
    if (child.marks.some((mark) => mark.type.name === "code")) {
      closeTo(0);
      flushPending();
      out += codeSpan(child.text ?? "");
      continue;
    }

    const text = child.text ?? "";
    const leading = /^\s*/.exec(text)?.[0] ?? "";
    const core = text.slice(leading.length).replace(/\s+$/, "");
    if (!core) {
      pending += text;
      continue;
    }
    const trailing = text.slice(leading.length + core.length);

    const target = orderedMarks(child.marks);
    let depth = 0;
    while (depth < open.length && depth < target.length && markKey(open[depth]) === markKey(target[depth])) {
      depth += 1;
    }
    if (depth < open.length) closeTo(depth);
    flushPending();
    out += leading;
    for (; depth < target.length; depth += 1) {
      open.push(target[depth]);
      out += markOpen(target[depth]);
    }
    out += escapeInline(core);
    pending = trailing;
  }

  closeTo(0);
  flushPending();
  return out;
}

function serializeList(list: PmNode, ordered: boolean): string {
  const start = ordered ? Number(list.attrs.start ?? 1) : 1;
  const items: string[] = [];

  for (let index = 0; index < list.childCount; index += 1) {
    const item = list.child(index);
    const marker = ordered ? `${start + index}. ` : "- ";
    items.push(serializeItem(item, marker));
  }
  return items.join(list.attrs.spread ? "\n\n" : "\n");
}

function serializeItem(item: PmNode, marker: string): string {
  let prefix = marker;
  const parts: Array<{ text: string; list: boolean }> = [];

  for (let index = 0; index < item.childCount; index += 1) {
    const child = item.child(index);
    const isFirstParagraph = index === 0 && child.type.name === "paragraph";
    const box = isFirstParagraph ? child.firstChild : null;

    if (isFirstParagraph && box && box.type.name === "task_box") {
      prefix = `- [${box.attrs.checked ? "x" : " "}] `;
      parts.push({ text: inlineMarkdown(child, true), list: false });
      continue;
    }
    parts.push({
      text: serializeBlock(child),
      list: child.type.name === "bullet_list" || child.type.name === "ordered_list",
    });
  }

  // A nested list starts on the very next line and needs only two spaces of indent; a
  // blank line there would turn the tight list into a loose one on every round trip.
  // Continuation blocks line up under the item text, so they use the marker width.
  const pad = " ".repeat(prefix.length);
  let out = "";
  for (const part of parts) {
    if (part.text.trim() === "") continue;
    const offset = part.list ? "  " : pad;
    const lines = part.text
      .split("\n")
      .map((line, index) => (index === 0 || line === "" ? line : offset + line));

    if (!out) out = prefix + lines.join("\n");
    else out += (part.list ? "\n" : "\n\n") + offset + lines.join("\n");
  }
  // An empty item keeps its marker and the space after it: "-" on its own is no longer
  // a list marker, and the next round trip would turn that item into a paragraph.
  return out || prefix;
}

function serializeBlock(node: PmNode): string {
  switch (node.type.name) {
    case "paragraph":
      return inlineMarkdown(node);
    case "heading":
      return `${"#".repeat(Number(node.attrs.level) || 1)} ${inlineMarkdown(node)}`;
    case "blockquote": {
      const body = serializeBlocks(node).join("\n\n");
      return body
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    }
    case "code_block": {
      const lang = String(node.attrs.lang ?? "");
      return `\`\`\`${lang}\n${node.textContent}\n\`\`\``;
    }
    case "math_block":
      return `$$\n${String(node.attrs.tex ?? "")}\n$$`;
    case "horizontal_rule":
      return "---";
    case "bullet_list":
      return serializeList(node, false);
    case "ordered_list":
      return serializeList(node, true);
    case "verbatim":
      return String(node.attrs.text ?? "");
    default:
      return node.textContent;
  }
}

function serializeBlocks(parent: PmNode): string[] {
  const out: string[] = [];
  for (let index = 0; index < parent.childCount; index += 1) {
    out.push(serializeBlock(parent.child(index)));
  }
  return out;
}

/**
 * Smallest single replacement that turns `before` into `after`.
 *
 * Replacing a whole buffer on every keystroke forces CodeMirror to re-measure the
 * document, and it clamps its scroll to the top while doing so. Sending only the span
 * that actually changed keeps the source pane's structure, scroll and history intact.
 */
export function minimalChange(before: string, after: string): { from: number; to: number; insert: string } {
  const limit = Math.min(before.length, after.length);
  let start = 0;
  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;

  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (
    beforeEnd > start &&
    afterEnd > start &&
    before.charCodeAt(beforeEnd - 1) === after.charCodeAt(afterEnd - 1)
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  return { from: start, to: beforeEnd, insert: after.slice(start, afterEnd) };
}

export function serializeMarkdown(doc: PmNode): string {
  const blocks = serializeBlocks(doc);

  // A block the user just opened with Enter is empty, and an empty block has no markdown
  // of its own. Dropping it would make Enter produce no visible change in the source, so
  // trailing empties become trailing blank lines — the line the caret is sitting on.
  let last = blocks.length;
  while (last > 0 && blocks[last - 1].trim() === "") last -= 1;
  const body = blocks.slice(0, last).filter((block) => block.trim() !== "");
  const trailing = blocks.length - last;

  if (body.length === 0) return "";
  return body.join("\n\n") + "\n".repeat(trailing + 1);
}

/* ------------------------------------------------------------- caret mapping */

function offsetOfPos(doc: PmNode, pos: number): number {
  let acc = 0;
  let found: number | null = null;

  doc.descendants((node, start) => {
    if (found !== null) return false;
    if (!node.isTextblock) return true;

    const end = start + node.nodeSize;
    if (pos >= start && pos <= end) {
      let inner = 0;
      let remaining = Math.max(0, Math.min(pos - (start + 1), node.content.size));
      for (let index = 0; index < node.childCount && remaining > 0; index += 1) {
        const child = node.child(index);
        if (remaining >= child.nodeSize) {
          inner += inlineMarkdownLength(child);
          remaining -= child.nodeSize;
        } else {
          inner += Math.min(remaining, inlineMarkdownLength(child));
          remaining = 0;
        }
      }
      found = acc + inner;
      return false;
    }

    acc += textblockMarkdownLength(node);
    return false;
  });

  return found ?? acc;
}

function posFromOffset(doc: PmNode, offset: number): number {
  let acc = 0;
  let found: number | null = null;

  doc.descendants((node, start) => {
    if (found !== null) return false;
    if (!node.isTextblock) return true;

    const length = textblockMarkdownLength(node);
    if (offset <= acc + length) {
      let remaining = offset - acc;
      let pos = start + 1;
      for (let index = 0; index < node.childCount && remaining > 0; index += 1) {
        const child = node.child(index);
        if (remaining >= child.nodeSize) {
          pos += child.nodeSize;
          remaining -= inlineMarkdownLength(child);
        } else {
          pos += Math.min(remaining, child.nodeSize);
          remaining = 0;
        }
      }
      found = Math.min(pos, start + node.nodeSize - 1);
      return false;
    }

    acc += length;
    return false;
  });

  return Math.max(1, found ?? doc.content.size);
}

/**
 * Exact markdown offsets for a selection, measured by serializing the document with an
 * invisible marker inserted at each end point. Deriving offsets from node sizes drifts
 * past list markers and block separators, which put the source caret in the wrong place.
 */
const MARKER_ANCHOR = "\uE000";
const MARKER_HEAD = "\uE001";

function offsetsOfSelection(doc: PmNode, from: number, to: number): { anchor: number; head: number } {
  const single = from === to;
  const transform = new Transform(doc);
  let placed = true;

  if (!single) {
    try {
      transform.insert(to, schema.text(MARKER_HEAD, doc.resolve(to).marks()));
    } catch {
      placed = false;
    }
  }
  try {
    transform.insert(from, schema.text(MARKER_ANCHOR, doc.resolve(from).marks()));
  } catch {
    placed = false;
  }

  if (!placed) return { anchor: offsetOfPos(doc, from), head: offsetOfPos(doc, to) };

  const text = serializeMarkdown(transform.doc);
  const anchor = text.indexOf(MARKER_ANCHOR);
  if (anchor < 0) return { anchor: offsetOfPos(doc, from), head: offsetOfPos(doc, to) };
  if (single) return { anchor, head: anchor };

  const headIndex = text.indexOf(MARKER_HEAD);
  if (headIndex < 0) return { anchor, head: offsetOfPos(doc, to) };
  return { anchor, head: headIndex - (anchor < headIndex ? 1 : 0) };
}

/* -------------------------------------------------------------- node views */

const IMAGE_REASON_MAX = 80;

class ImageView {
  dom: HTMLElement;

  constructor(private node: PmNode, private ctx: { dir: string | null }) {
    this.dom = document.createElement("img");
    this.dom.className = "pm-image";
    this.dom.setAttribute("alt", String(node.attrs.alt ?? ""));
    void this.resolve();
  }

  update(node: PmNode): boolean {
    if (node.type.name !== "image") return false;
    this.node = node;
    this.dom = document.createElement("img");
    this.dom.className = "pm-image";
    this.dom.setAttribute("alt", String(node.attrs.alt ?? ""));
    void this.resolve();
    return true;
  }

  private async resolve(): Promise<void> {
    const src = String(this.node.attrs.src ?? "");
    const image = this.dom as HTMLImageElement;
    if (!src) return;
    if (/^data:image\//i.test(src)) {
      image.src = src;
      return;
    }
    if (/^[a-z]+:\/\//i.test(src) || src.startsWith("//")) {
      this.blocked("remote image blocked");
      return;
    }
    if (!this.ctx.dir) return;

    try {
      image.src = await invoke<string>("read_image", { docDir: this.ctx.dir, relPath: src });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.blocked(message.slice(0, IMAGE_REASON_MAX));
    }
  }

  private blocked(reason: string): void {
    const holder = document.createElement("span");
    holder.className = "img-blocked";
    holder.textContent = `[${this.node.attrs.alt || "image"}: ${reason}]`;
    holder.title = String(this.node.attrs.src ?? "");
    this.dom = holder;
  }
}

class TaskBoxView {
  dom: HTMLElement;
  private input: HTMLInputElement;

  constructor(
    node: PmNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.dom = document.createElement("span");
    this.dom.className = "pm-task-box";
    this.input = document.createElement("input");
    this.input.type = "checkbox";
    this.input.className = "pm-task-input";
    this.input.checked = Boolean(node.attrs.checked);
    this.input.setAttribute("aria-label", "Task complete");
    // Keeping the caret out of the checkbox makes clicking it a toggle, not a click-into-text.
    this.input.addEventListener("mousedown", (event) => event.preventDefault());
    this.input.addEventListener("change", () => {
      const pos = this.getPos();
      if (typeof pos !== "number") return;
      this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { checked: this.input.checked }));
    });
    this.dom.append(this.input);
  }

  update(node: PmNode): boolean {
    if (node.type.name !== "task_box") return false;
    this.input.checked = Boolean(node.attrs.checked);
    return true;
  }

  stopEvent(): boolean {
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }
}

class MathView {
  dom: HTMLElement;
  private display: boolean;

  constructor(private node: PmNode) {
    this.display = node.type.name === "math_block";
    this.dom = document.createElement(this.display ? "div" : "span");
    this.dom.className = this.display ? "pm-math pm-math-block" : "pm-math";
    this.dom.contentEditable = "false";
    this.draw();
  }

  update(node: PmNode): boolean {
    if (node.type.name !== this.node.type.name) return false;
    this.node = node;
    this.draw();
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  private draw(): void {
    const tex = String(this.node.attrs.tex ?? "");
    this.dom.classList.remove("math-error");
    try {
      katex.render(tex, this.dom, {
        displayMode: this.display,
        throwOnError: false,
        strict: "ignore",
        trust: false,
        output: "htmlAndMathml",
      });
    } catch {
      this.dom.textContent = tex;
      this.dom.classList.add("math-error");
    }
  }
}

/**
 * Code blocks stay editable in place. A ```mermaid block also draws its diagram above the
 * source, so the picture and the code that produced it travel together; editing the code
 * redraws it after a short pause.
 */
class CodeBlockView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private diagram: HTMLElement;
  private node: PmNode;
  private generation = 0;
  private timer = 0;

  constructor(node: PmNode) {
    this.node = node;
    this.dom = document.createElement("div");
    this.dom.className = "pm-code";

    this.diagram = document.createElement("div");
    this.diagram.className = "pm-diagram";
    this.diagram.hidden = true;
    this.dom.append(this.diagram);

    const pre = document.createElement("pre");
    pre.className = "hljs";
    pre.dataset.lang = String(node.attrs.lang ?? "");
    const code = document.createElement("code");
    pre.append(code);
    this.dom.append(pre);

    this.contentDOM = code;
    this.plan();
  }

  update(node: PmNode): boolean {
    if (node.type.name !== "code_block") return false;
    const langChanged = String(node.attrs.lang ?? "") !== String(this.node.attrs.lang ?? "");
    this.node = node;
    this.dom.querySelector("pre")?.setAttribute("data-lang", String(node.attrs.lang ?? ""));
    if (langChanged) this.plan();
    else if (this.isMermaid()) this.scheduleDraw();
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    // Redrawing the diagram must not look like the user editing the code text.
    return !this.contentDOM.contains(mutation.target);
  }

  private isMermaid(): boolean {
    return String(this.node.attrs.lang ?? "").trim().toLowerCase() === "mermaid";
  }

  private plan(): void {
    window.clearTimeout(this.timer);
    if (!this.isMermaid()) {
      this.diagram.hidden = true;
      this.diagram.replaceChildren();
      this.dom.classList.remove("pm-code-mermaid");
      return;
    }
    this.dom.classList.add("pm-code-mermaid");
    this.scheduleDraw();
  }

  private scheduleDraw(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.draw(), 320);
  }

  private async draw(): Promise<void> {
    const source = this.node.textContent;
    if (!source.trim()) {
      this.diagram.hidden = true;
      return;
    }

    this.generation += 1;
    const generation = this.generation;
    try {
      const svg = await renderMermaidSvg(source);
      if (generation !== this.generation) return;
      this.diagram.innerHTML = svg;
      this.diagram.classList.remove("mermaid-error");
      this.diagram.hidden = false;
    } catch (err) {
      if (generation !== this.generation) return;
      this.diagram.textContent = `Diagram error: ${String(err).slice(0, 160)}`;
      this.diagram.classList.add("mermaid-error");
      this.diagram.hidden = false;
    }
  }
}

/* ------------------------------------------------------------------ factory */

export interface WysiwygOptions {
  docDir: string | null;
  /** Called with the serialized markdown and the caret offsets to restore in the source. */
  onEdit: (markdown: string, anchor: number, head: number) => void;
  /** Called whenever the caret moves without an edit, so the source pane can follow it. */
  onSelect: (anchor: number, head: number) => void;
  onUndo: () => void;
  onRedo: () => void;
}

export interface Wysiwyg {
  /** Exposed so the app can check focus and tests can drive the document directly. */
  view: EditorView;
  setMarkdown: (markdown: string, caret: number) => void;
  setDocDir: (dir: string | null) => void;
  destroy: () => void;
}

export function createWysiwyg(host: HTMLElement, initial: string, options: WysiwygOptions): Wysiwyg {
  const ctx = { dir: options.docDir };
  let lastSource = initial;
  let applying = false;

  const nodeViews: { [name: string]: NodeViewConstructor } = {
    image: (node) => new ImageView(node, ctx),
    task_box: (node, view, getPos) => new TaskBoxView(node, view, getPos),
    math_inline: (node) => new MathView(node),
    math_block: (node) => new MathView(node),
    code_block: (node) => new CodeBlockView(node),
  };

  const plugins = [
    keymap({
      "Mod-z": () => {
        options.onUndo();
        return true;
      },
      "Mod-y": () => {
        options.onRedo();
        return true;
      },
      "Mod-Shift-z": () => {
        options.onRedo();
        return true;
      },
      "Mod-b": toggleMark(schema.marks.strong),
      "Mod-i": toggleMark(schema.marks.em),
      Enter: splitListItem(schema.nodes.list_item),
      Tab: sinkListItem(schema.nodes.list_item),
      "Shift-Tab": liftListItem(schema.nodes.list_item),
    }),
    keymap(baseKeymap),
  ];

  let view!: EditorView;

  view = new EditorView(host, {
    state: EditorState.create({ schema, doc: parseMarkdown(initial), plugins }),
    nodeViews,
    attributes: { class: "pm-content", "aria-label": "Rendered pane, editable", spellcheck: "false" },
    dispatchTransaction(transaction: Transaction) {
      const next = view.state.apply(transaction);
      view.updateState(next);
      if (applying) return;

      // A click or arrow key in this pane must move the source caret too, otherwise the
      // ribbon and any later typing in Raw act on a caret the user has already left.
      if (!transaction.docChanged) {
        if (transaction.selectionSet) {
          const { anchor, head } = offsetsOfSelection(next.doc, next.selection.from, next.selection.to);
          options.onSelect(anchor, head);
        }
        return;
      }

      lastSource = serializeMarkdown(next.doc);
      const { anchor, head } = offsetsOfSelection(next.doc, next.selection.from, next.selection.to);
      options.onEdit(lastSource, anchor, head);
    },
  });

  return {
    view,
    setMarkdown(markdown: string, caret: number) {
      if (markdown === lastSource) {
        const pos = posFromOffset(view.state.doc, caret);
        if (pos !== view.state.selection.from) {
          applying = true;
          try {
            view.dispatch(
              view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))),
            );
          } finally {
            applying = false;
          }
        }
        return;
      }

      const parsed = parseMarkdown(markdown);
      applying = true;
      try {
        const transaction = view.state.tr.replaceWith(0, view.state.doc.content.size, parsed.content);
        const pos = posFromOffset(transaction.doc, caret);
        view.dispatch(transaction.setSelection(TextSelection.near(transaction.doc.resolve(pos))));
        lastSource = markdown;
      } finally {
        applying = false;
      }
    },
    setDocDir(dir: string | null) {
      ctx.dir = dir;
    },
    destroy() {
      view.destroy();
    },
  };
}
