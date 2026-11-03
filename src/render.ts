import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";
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

const md: MarkdownIt = new MarkdownIt({
  // Raw HTML is allowed (GitHub parity), but every rendered byte is sanitized below.
  html: true,
  linkify: true,
  breaks: false,
  typographer: false,
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(code, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
      } catch {
        // fall through to the escaped version
      }
    }
    return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`;
  },
});

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
  FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "input", "link", "meta", "base", "video", "audio"],
  FORBID_ATTR: ["style", "srcset", "formaction", "ping", "autofocus"],
  ALLOW_DATA_ATTR: false,
  KEEP_CONTENT: true,
};

export function renderToHtml(source: string): string {
  return DOMPurify.sanitize(md.render(source), SANITIZE_OPTIONS);
}

const IMAGE_BUDGET = 60;

/** Post-processes sanitized preview HTML: images, task checkboxes, link routing. */
export async function hydratePreview(root: HTMLElement, docDir: string | null): Promise<void> {
  root.querySelectorAll("article input, article .markdown-body input, input").forEach((el) => {
    if (el instanceof HTMLInputElement) {
      el.disabled = true;
      el.setAttribute("aria-hidden", "true");
    }
  });

  root.querySelectorAll("a[href]").forEach((el) => {
    el.setAttribute("rel", "noreferrer noopener");
  });

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
