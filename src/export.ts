/**
 * Standalone HTML export.
 *
 * The exported page is a single file: document styles are inlined, images become data
 * URLs (the same mechanism the preview uses), maths is typeset into the page, and diagrams
 * are drawn before serializing. Nothing in it points back at the machine that wrote it.
 */
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";

import exportCss from "./styles/export.css?raw";
import { hydrateMath, hydrateMermaid, hydratePreview, renderToHtml } from "./render";
import { customCssText } from "./theme";
import { baseName } from "./types";
import type { Doc } from "./types";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface ExportOptions {
  markdown: string;
  docDir: string | null;
  title: string;
}

export async function buildStandaloneHtml(options: ExportOptions): Promise<string> {
  const host = document.createElement("div");
  host.innerHTML = renderToHtml(options.markdown);

  hydrateMath(host);
  // Inlines local images and link handling exactly like the preview does.
  await hydratePreview(host, options.docDir);
  await hydrateMermaid(host);

  const custom = customCssText();
  const styles = custom ? `${exportCss}\n/* Custom theme */\n${custom}` : exportCss;

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="Markdown Studio">',
    `<title>${escapeHtml(options.title)}</title>`,
    "<style>",
    styles,
    "</style>",
    "</head>",
    "<body>",
    '<article class="markdown-body">',
    host.innerHTML,
    "</article>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** Asks for a target and writes the export. Throws with the Rust error on failure. */
export async function exportDocHtml(doc: Doc, markdown: string): Promise<string | null> {
  const suggested = doc.path
    ? doc.path.replace(/\.[^.\\/]+$/, ".html")
    : `${doc.name === "Untitled" ? "Untitled" : doc.name.replace(/\.md$/i, "")}.html`;

  const chosen = await saveDialog({
    title: "Export standalone HTML",
    defaultPath: suggested,
    filters: [{ name: "HTML page", extensions: ["html"] }],
    canCreateDirectories: true,
  });
  if (typeof chosen !== "string") return null;

  const title = baseName(chosen).replace(/\.html?$/i, "") || "Document";
  const html = await buildStandaloneHtml({ markdown, docDir: doc.dir, title });
  await invoke("export_html", { path: chosen, html });
  return chosen;
}
