import { invoke } from "@tauri-apps/api/core";
import type { TreeEntry } from "./types";

const MAX_DEPTH = 12;

/** Windows-style case-insensitive comparison helper for tree paths. */
function normPath(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("\\") || dir.endsWith("/") ? `${dir}${name}` : `${dir}\\${name}`;
}

/**
 * Parent directory of a Windows path, or null when there is nothing above it: a drive
 * root (`C:\`) and a network share root (`\\server\share`) are both terminal, because
 * listing anything above them is either pointless or very slow.
 */
export function parentDir(path: string): string | null {
  const norm = path.replace(/\//g, "\\").replace(/\\+$/, "");
  if (!norm) return null;

  const parts = norm.split("\\").filter(Boolean);

  if (norm.startsWith("\\\\")) {
    if (parts.length <= 2) return null;
    return `\\\\${parts.slice(0, -1).join("\\")}`;
  }

  if (!/^[A-Za-z]:$/.test(parts[0] ?? "")) return null;
  if (parts.length <= 1) return null;
  return parts.length === 2 ? `${parts[0]}\\` : `${parts[0]}\\${parts.slice(1, -1).join("\\")}`;
}

export function isUnderRoot(root: string, path: string): boolean {
  const base = normPath(root);
  const target = normPath(path);
  return target === base || target.startsWith(`${base}\\`);
}

/** Read-only, lazily expanded markdown tree. */
export class Sidebar {
  private root: string | null = null;
  private activePath: string | null = null;
  private revealToken = 0;
  /** Incremented by every open(); a listing from an older token must not be appended. */
  private loadToken = 0;
  /** In-flight child loads, so two reveals reaching one folder share a single request. */
  private readonly pendingLoads = new WeakMap<HTMLElement, Promise<void>>();
  private readonly tree: HTMLElement;
  private readonly title: HTMLElement;
  private readonly onOpen: (path: string) => void;
  private readonly onUp: (dir: string) => void;

  constructor(
    tree: HTMLElement,
    title: HTMLElement,
    onOpen: (path: string) => void,
    onUp: (dir: string) => void,
  ) {
    this.tree = tree;
    this.title = title;
    this.onOpen = onOpen;
    this.onUp = onUp;
  }

  getRoot(): string | null {
    return this.root;
  }

  async open(root: string): Promise<void> {
    const token = ++this.loadToken;
    this.revealToken += 1;
    this.root = root;
    this.title.textContent = root;
    this.title.title = root;
    this.tree.replaceChildren();
    const parent = parentDir(root);
    if (parent) this.tree.append(this.makeUpRow(parent));
    await this.loadInto(this.tree, root, 0, token);
  }

  async reload(): Promise<void> {
    if (this.root) await this.open(this.root);
  }

  clear(): void {
    this.revealToken += 1;
    this.root = null;
    this.title.textContent = "No folder open";
    this.title.title = "";
    this.tree.replaceChildren();
  }

  setActive(path: string | null): void {
    this.activePath = path;
    this.applyActive();
  }

  /**
   * Follows the open document: expands every folder between the tree root and the
   * file, then highlights and scrolls the matching row into view.
   */
  async reveal(path: string | null): Promise<void> {
    this.activePath = path;
    this.applyActive();

    const token = ++this.revealToken;
    if (!path || !this.root || !isUnderRoot(this.root, path)) return;

    const rootDepth = this.root.split(/[\\/]/).filter(Boolean).length;
    const segments = path.split(/[\\/]/).filter(Boolean).slice(rootDepth);
    if (segments.length === 0) return;

    let host: HTMLElement = this.tree;
    let dir = this.root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      if (index + 1 > MAX_DEPTH) return;
      dir = joinPath(dir, segments[index]);
      const wrap = this.findDir(host, dir);
      if (!wrap) return;
      await this.expand(wrap);
      if (token !== this.revealToken) return;
      const children = wrap.querySelector<HTMLElement>(":scope > .tree-children");
      if (!children) return;
      host = children;
    }

    this.applyActive();
    this.findFile(host, path)?.scrollIntoView({ block: "nearest" });
  }

  private applyActive(): void {
    const wanted = this.activePath === null ? null : normPath(this.activePath);
    this.tree.querySelectorAll<HTMLElement>(".tree-row.file").forEach((row) => {
      const same = wanted !== null && normPath(row.dataset.path ?? "") === wanted;
      row.classList.toggle("active", same);
    });
  }

  private findDir(host: HTMLElement, dir: string): HTMLElement | null {
    const wanted = normPath(dir);
    for (const child of Array.from(host.children)) {
      const element = child as HTMLElement;
      if (!element.classList.contains("tree-dir")) continue;
      if (normPath(element.dataset.path ?? "") === wanted) return element;
    }
    return null;
  }

  private findFile(host: HTMLElement, path: string): HTMLElement | null {
    const wanted = normPath(path);
    for (const row of Array.from(host.querySelectorAll<HTMLElement>(".tree-row.file"))) {
      if (normPath(row.dataset.path ?? "") === wanted) return row;
    }
    return null;
  }

  private async expand(wrap: HTMLElement): Promise<void> {
    const row = wrap.querySelector<HTMLElement>(":scope > .tree-row.dir");
    const children = wrap.querySelector<HTMLElement>(":scope > .tree-children");
    if (!row || !children) return;

    if (!children.dataset.loaded) {
      const depth = Number(wrap.dataset.depth ?? "0");
      if (depth + 1 > MAX_DEPTH) return;

      // Two reveals routinely reach the same folder at once: startup restores several
      // tabs and each activation reveals without awaiting. Share the in-flight load
      // instead of starting a second one, which appended every child twice.
      const token = this.loadToken;
      let pending = this.pendingLoads.get(children);
      if (!pending) {
        pending = this.loadInto(children, wrap.dataset.path ?? "", depth + 1, token).finally(() => {
          this.pendingLoads.delete(children);
        });
        this.pendingLoads.set(children, pending);
      }
      await pending;
      if (token === this.loadToken) children.dataset.loaded = "1";
    }

    children.hidden = false;
    row.classList.add("expanded");
    row.setAttribute("aria-expanded", "true");
    const twisty = row.querySelector(".twisty");
    if (twisty) twisty.textContent = "\u25BE";
  }

  private collapse(wrap: HTMLElement): void {
    const row = wrap.querySelector<HTMLElement>(":scope > .tree-row.dir");
    const children = wrap.querySelector<HTMLElement>(":scope > .tree-children");
    if (!row || !children) return;

    children.hidden = true;
    row.classList.remove("expanded");
    row.setAttribute("aria-expanded", "false");
    const twisty = row.querySelector(".twisty");
    if (twisty) twisty.textContent = "\u25B8";
  }

  private async loadInto(host: HTMLElement, dir: string, depth: number, token: number): Promise<void> {
    let entries: TreeEntry[] = [];
    try {
      entries = await invoke<TreeEntry[]>("list_folder", { path: dir });
    } catch {
      entries = [];
    }

    // A newer open() owns the tree now; appending this listing would splice two folders
    // into one another.
    if (token !== this.loadToken) return;

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.style.paddingLeft = `${10 + depth * 12}px`;
      empty.textContent = "No markdown files";
      host.append(empty);
      return;
    }
    for (const entry of entries) {
      if (token !== this.loadToken) return;
      host.append(entry.isDir ? this.makeDir(entry, depth) : this.makeFile(entry, depth));
    }
  }

  /** The `..` row: re-roots the tree one level up, where the folder permits it. */
  private makeUpRow(parent: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "tree-row up";
    row.style.paddingLeft = "8px";
    row.setAttribute("role", "treeitem");
    row.tabIndex = 0;
    row.title = `Go up to ${parent}`;

    const glyph = document.createElement("span");
    glyph.className = "twisty";
    glyph.textContent = "\u2191";

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = "..";

    const activate = (): void => this.onUp(parent);
    row.append(glyph, label);
    row.addEventListener("click", activate);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });
    return row;
  }

  private makeDir(entry: TreeEntry, depth: number): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "tree-dir";
    wrap.dataset.path = entry.path;
    wrap.dataset.depth = String(depth);

    const row = document.createElement("div");
    row.className = "tree-row dir";
    row.style.paddingLeft = `${8 + depth * 12}px`;
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-expanded", "false");
    row.title = entry.path;

    const twisty = document.createElement("span");
    twisty.className = "twisty";
    twisty.textContent = "\u25B8";

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = entry.name;

    row.append(twisty, label);

    const children = document.createElement("div");
    children.className = "tree-children";
    children.hidden = true;

    row.addEventListener("click", () => {
      if (children.hidden) void this.expand(wrap);
      else this.collapse(wrap);
    });

    wrap.append(row, children);
    return wrap;
  }

  private makeFile(entry: TreeEntry, depth: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "tree-row file";
    row.style.paddingLeft = `${8 + depth * 12}px`;
    row.setAttribute("role", "treeitem");
    row.dataset.path = entry.path;
    row.title = entry.path;
    row.textContent = entry.name;
    if (this.activePath !== null && normPath(entry.path) === normPath(this.activePath)) {
      row.classList.add("active");
    }
    row.addEventListener("click", () => this.onOpen(entry.path));
    return row;
  }
}
