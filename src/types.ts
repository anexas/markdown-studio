import type { EditorState } from "@codemirror/state";

export type ViewMode = "raw" | "split" | "preview";

/** A single open buffer. Unsaved documents have `path === null`. */
export interface Doc {
  id: string;
  path: string | null;
  name: string;
  dir: string | null;
  /** Line ending used when the file was last read, preserved on save. */
  eol: "\n" | "\r\n";
  /** Whether the source file started with a UTF-8 BOM. */
  bom: boolean;
  /** Content as last read/written from disk; the dirty check compares against it. */
  savedContent: string;
  /** Inactive buffers keep a full EditorState so undo history and cursor survive. */
  state: EditorState | null;
  editorScroll: number;
  previewScroll: number;
}

export interface DocPayload {
  content: string;
  eol: string;
  bom: boolean;
}

export interface TreeEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export const MARKDOWN_EXTENSIONS = ["md", "markdown", "mdown", "mkd"] as const;

export function isMarkdownPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return (MARKDOWN_EXTENSIONS as readonly string[]).includes(ext);
}

/** Basename that also works for paths arriving from Windows or drag sources. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function dirName(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx > 0 ? path.slice(0, idx) : path;
}
