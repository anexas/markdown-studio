import MarkdownIt from "markdown-it";
import type { StateBlock, StateInline } from "markdown-it";
import anchor from "markdown-it-anchor";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";
import katex from "katex";
import { invoke } from "@tauri-apps/api/core";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slugify(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

/* --------------------------------------------------------------------- maths */

/**
 * `$inline$` and `$$display$$` become placeholder elements, not KaTeX markup: the document
 * is sanitized first, and only then is each placeholder replaced with KaTeX output. KaTeX
 * needs inline styles for spacing, which the sanitizer removes on purpose, so rendering it
 * before sanitizing would quietly break every formula.
 */
function mathInlineRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x24 /* $ */) return false;
  if (state.src.charCodeAt(start + 1) === 0x24) return false; // display maths
  if (start + 2 >= state.posMax) return false;

  const first = state.src[start + 1];
  // "$5 and $10" is prose, not a formula.
  if (first === " " || first === "\t" || first === "\n") return false;

  let end = start + 1;
  while (end < state.posMax) {
    const ch = state.src[end];
    if (ch === "\\") {
      end += 2;
      continue;
    }
    if (ch === "$") break;
    if (ch === "\n") return false;
    end += 1;
  }
  if (end >= state.posMax) return false;

  const inner = state.src.slice(start + 1, end);
  if (!inner.trim() || /\s$/.test(inner)) return false;
  const after = state.src[end + 1];
  if (after && /[0-9]/.test(after)) return false;

  if (silent) return true;
  const token = state.push("math_inline", "math", 0);
  token.markup = "$";
  token.content = inner;
  state.pos = end + 1;
  return true;
}

function mathBlockRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  if (start + 2 > max) return false;
  if (state.src.slice(start, start + 2) !== "$$") return false;
  if (silent) return true;

  const body: string[] = [];
  let next = startLine;
  let closed = false;

  const firstLine = state.src.slice(start + 2, max);
  if (firstLine.trim().endsWith("$$") && firstLine.trim().length > 2) {
    body.push(firstLine.trim().slice(0, -2));
    closed = true;
  } else {
    body.push(firstLine);
    while (next + 1 < endLine) {
      next += 1;
      const lineStart = state.bMarks[next] + Math.min(state.tShift[next], state.blkIndent);
      const raw = state.src.slice(lineStart, state.eMarks[next]);
      const trimmed = raw.trim();

      if (trimmed.endsWith("$$")) {
        body.push(trimmed.slice(0, -2));
        closed = true;
        break;
      }
      if (trimmed === "") {
        body.push("");
        continue;
      }
      if (state.tShift[next] < state.blkIndent) break;
      body.push(raw);
    }
  }

  // No closing $$: leave the lines to the normal paragraph rules rather than swallowing
  // the rest of the document.
  if (!closed) return false;

  state.line = next + 1;
  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.map = [startLine, state.line];
  token.content = body.join("\n").trim();
  return true;
}

/** Registers the maths rules. Shared with the rendered pane's parser. */
export function mathPlugin(mdInstance: MarkdownIt): void {
  mdInstance.inline.ruler.before("backticks", "math_inline", mathInlineRule);
  mdInstance.block.ruler.before("fence", "math_block", mathBlockRule, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  mdInstance.renderer.rules.math_inline = (tokens, idx) =>
    `<span class="math-src">${escapeHtml(tokens[idx].content)}</span>`;
  mdInstance.renderer.rules.math_block = (tokens, idx) =>
    `<div class="math-src math-display">${escapeHtml(tokens[idx].content)}</div>`;
}

/* ------------------------------------------------------------------ markdown */

const md: MarkdownIt = new MarkdownIt({
  // Raw HTML is allowed (GitHub parity), but every rendered byte is sanitized below.
  html: true,
  linkify: true,
  breaks: false,
  typographer: false,
  highlight(code, lang) {
    const language = (lang ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    // Diagrams are drawn after sanitizing, so the block travels as escaped source text.
    if (language === "mermaid") {
      return `<pre class="hljs mermaid-src"><code>${escapeHtml(code)}</code></pre>`;
    }
    if (language && hljs.getLanguage(language)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(code, { language, ignoreIllegals: true }).value}</code></pre>`;
      } catch {
        // fall through to the escaped version
      }
    }
    return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`;
  },
});

mathPlugin(md);

md.use(footnote)
  .use(taskLists, { enabled: false, label: false })
  .use(anchor, { permalink: false, slugify, uniqueSlugStartIndex: 1 });

interface SanitizeOptions {
  FORBID_TAGS: string[];
  FORBID_ATTR: string[];
  ALLOW_DATA_ATTR: boolean;
  KEEP_CONTENT: boolean;
}

const SANITIZE_OPTIONS: SanitizeOptions = {
  // `input` is deliberately absent: task lists need their checkbox to survive. The hook
  // below narrows it back down to a disabled, unnamed checkbox and drops everything else.
  FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "link", "meta", "base", "video", "audio"],
  FORBID_ATTR: ["style", "srcset", "formaction", "ping", "autofocus"],
  ALLOW_DATA_ATTR: false,
  KEEP_CONTENT: true,
};

/**
 * A preview needs exactly one kind of form control. Allowing `input` wholesale would let a
 * document render text boxes or buttons, so anything that is not a checkbox is removed, and
 * the survivors lose their name so they can never take part in a submission.
 */
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeName !== "INPUT") return;
  const element = node as Element;

  if (element.getAttribute("type") !== "checkbox") {
    element.parentNode?.removeChild(element);
    return;
  }
  element.removeAttribute("name");
  element.setAttribute("disabled", "");
});

export function renderToHtml(source: string): string {
  return DOMPurify.sanitize(md.render(source), SANITIZE_OPTIONS);
}

/* ----------------------------------------------------------------- hydration */

/**
 * Replaces maths placeholders with KaTeX output. Runs after sanitizing, on HTML the
 * sanitizer has already accepted, and the TeX it reads is text content — never markup.
 */
export function hydrateMath(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>(".math-src").forEach((holder) => {
    const tex = holder.textContent ?? "";
    const display = holder.classList.contains("math-display");
    try {
      holder.innerHTML = katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        strict: "ignore",
        trust: false,
        output: "htmlAndMathml",
      });
      holder.classList.remove("math-src");
      holder.classList.add("math-rendered");
    } catch {
      holder.classList.add("math-error");
      holder.title = "This formula could not be typeset";
    }
  });
}

let mermaidCounter = 0;
let mermaidModule: Promise<typeof import("mermaid").default> | null = null;

/** Mermaid is by far the largest dependency here, so it is fetched on first use. */
async function loadMermaid(): Promise<typeof import("mermaid").default> {
  if (!mermaidModule) {
    mermaidModule = import("mermaid").then((mod) => mod.default);
  }
  return mermaidModule;
}

/**
 * Reads a CSS variable as a usable colour. Later names are fallbacks, and an unresolved
 * `var()` chain is skipped rather than handed to Mermaid, which cannot parse it.
 */
function themeColor(...names: string[]): string {
  const style = getComputedStyle(document.documentElement);
  for (const name of names) {
    const value = style.getPropertyValue(name).trim();
    if (value && !value.includes("var(")) return value;
  }
  return "";
}

/**
 * Mermaid writes its palette into the SVG as attributes, so a stylesheet cannot recolour a
 * diagram — the colours have to be handed over at draw time. These are the `--diagram-*`
 * variables, falling back to the theme's own palette when a stylesheet does not set them.
 */
function diagramThemeVariables(): Record<string, string> {
  const bg = themeColor("--diagram-bg", "--bg") || "#ffffff";
  const nodeBg = themeColor("--diagram-node-bg", "--code-bg", "--bg-elevated") || bg;
  const nodeBorder = themeColor("--diagram-node-border", "--border") || "#d8dee4";
  const nodeText = themeColor("--diagram-node-text", "--fg") || "#1f2328";
  const line = themeColor("--diagram-line", "--fg-muted") || nodeText;
  const text = themeColor("--diagram-text", "--fg") || nodeText;
  const labelBg = themeColor("--diagram-label-bg", "--bg") || bg;
  const clusterBg = themeColor("--diagram-cluster-bg", "--bg-elevated") || nodeBg;
  const clusterBorder = themeColor("--diagram-cluster-border", "--border") || nodeBorder;
  const noteBg = themeColor("--diagram-note-bg", "--code-bg") || nodeBg;
  const noteBorder = themeColor("--diagram-note-border", "--border") || nodeBorder;
  const accent = themeColor("--diagram-accent", "--accent") || nodeBorder;

  return {
    background: bg,
    primaryColor: nodeBg,
    primaryTextColor: nodeText,
    primaryBorderColor: nodeBorder,
    secondaryColor: clusterBg,
    tertiaryColor: labelBg,
    lineColor: line,
    textColor: text,
    mainBkg: nodeBg,
    nodeBorder,
    nodeTextColor: nodeText,
    titleColor: text,
    edgeLabelBackground: labelBg,
    clusterBkg: clusterBg,
    clusterBorder,
    // Sequence diagrams name the same surfaces differently.
    actorBkg: nodeBg,
    actorBorder: nodeBorder,
    actorTextColor: nodeText,
    signalColor: line,
    signalTextColor: text,
    labelBoxBkgColor: nodeBg,
    labelBoxBorderColor: nodeBorder,
    labelTextColor: nodeText,
    loopTextColor: text,
    activationBkgColor: clusterBg,
    activationBorderColor: nodeBorder,
    noteBkgColor: noteBg,
    noteBorderColor: noteBorder,
    noteTextColor: text,
    // Pie slices have no semantic colour, so they walk the palette.
    pie1: accent,
    pie2: clusterBorder,
    pie3: noteBorder,
    pie4: line,
    pieTitleTextSize: "16px",
    pieSectionTextColor: nodeText,
  };
}

/** Typesets one diagram and returns its SVG. Used by the preview and the rendered pane. */
export async function renderMermaidSvg(source: string): Promise<string> {
  const mermaid = await loadMermaid();
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    // "base" applies the variables below as-is; the stock light/dark themes ignore them.
    theme: "base",
    themeVariables: diagramThemeVariables(),
    fontFamily:
      themeColor("--font-ui") || '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
    suppressErrorRendering: true,
  });
  mermaidCounter += 1;
  const { svg } = await mermaid.render(`mermaid-${mermaidCounter}`, source);
  return svg;
}

/** Draws every ```mermaid block in place. */
export async function hydrateMermaid(root: ParentNode): Promise<void> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("pre.mermaid-src"));
  if (blocks.length === 0) return;

  for (const block of blocks) {
    const source = block.textContent ?? "";
    if (!source.trim()) continue;
    try {
      const svg = await renderMermaidSvg(source);
      const holder = document.createElement("div");
      holder.className = "mermaid-diagram";
      holder.innerHTML = svg;
      block.replaceWith(holder);
    } catch (err) {
      // Keep the source visible: a broken diagram should still be readable and fixable.
      block.classList.add("mermaid-error");
      block.title = String(err);
    }
  }
}

const IMAGE_BUDGET = 60;

/** Post-processes sanitized preview HTML: maths, diagrams, images, links. */
export async function hydratePreview(root: HTMLElement, docDir: string | null): Promise<void> {
  hydrateMath(root);

  root.querySelectorAll("article input, article .markdown-body input, input").forEach((el) => {
    if (el instanceof HTMLInputElement) {
      el.disabled = true;
      el.setAttribute("aria-hidden", "true");
    }
  });

  root.querySelectorAll("a[href]").forEach((el) => {
    el.setAttribute("rel", "noreferrer noopener");
  });

  await hydrateMermaid(root);

  if (!docDir) return;

  const images = Array.from(root.querySelectorAll("img")).slice(0, IMAGE_BUDGET);
  await Promise.all(
    images.map(async (img) => {
      const src = (img.getAttribute("src") ?? "").trim();
      if (!src) return;
      if (/^data:image\//i.test(src)) return;
      if (/^[a-z]+:\/\//i.test(src) || src.startsWith("//")) {
        replaceImage(img, "remote image blocked");
        return;
      }
      try {
        const dataUrl = await invoke<string>("read_image", { docDir, relPath: src });
        img.setAttribute("src", dataUrl);
        img.removeAttribute("loading");
      } catch (err) {
        replaceImage(img, errorText(err));
      }
    }),
  );
}

function replaceImage(img: HTMLImageElement, reason: string): void {
  const holder = document.createElement("span");
  holder.className = "img-blocked";
  holder.textContent = `[${img.getAttribute("alt") || "image"}: ${reason}]`;
  holder.title = img.getAttribute("src") ?? "";
  img.replaceWith(holder);
}

function errorText(err: unknown): string {
  const raw = typeof err === "string" ? err : err instanceof Error ? err.message : "unavailable";
  return raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
}
