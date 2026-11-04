import type { PaneView, ViewMode } from "./types";

const SESSION_KEY = "markdown-studio.session.v1";
const MAX_RECENT = 12;

export const ZOOM_MIN = 0.6;
export const ZOOM_MAX = 2.4;

export interface Session {
  mode: ViewMode;
  /** Right pane view in Split: the editable rendered pane, or the read-only preview. */
  paneView: PaneView;
  /** Text scale for the editor and preview, 1 = 100%. */
  zoom: number;
  activeIndex: number;
  tabs: string[];
  sidebar: { root: string | null; width: number; visible: boolean };
  recent: string[];
}

export const DEFAULT_SESSION: Session = {
  mode: "split",
  paneView: "rendered",
  zoom: 1,
  activeIndex: 0,
  tabs: [],
  sidebar: { root: null, width: 240, visible: false },
  recent: [],
};

export function loadSession(): Session {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return { ...DEFAULT_SESSION, sidebar: { ...DEFAULT_SESSION.sidebar } };
    const parsed = JSON.parse(raw) as Partial<Session>;
    return {
      mode: parsed.mode === "raw" || parsed.mode === "preview" ? parsed.mode : "split",
      paneView: parsed.paneView === "preview" ? "preview" : "rendered",
      zoom: clampZoom(parsed.zoom),
      activeIndex: typeof parsed.activeIndex === "number" ? parsed.activeIndex : 0,
      tabs: Array.isArray(parsed.tabs) ? parsed.tabs.filter((t) => typeof t === "string") : [],
      sidebar: {
        root: typeof parsed.sidebar?.root === "string" ? parsed.sidebar.root : null,
        width: clampWidth(parsed.sidebar?.width),
        visible: parsed.sidebar?.visible === true,
      },
      recent: Array.isArray(parsed.recent) ? parsed.recent.filter((r) => typeof r === "string").slice(0, MAX_RECENT) : [],
    };
  } catch {
    return { ...DEFAULT_SESSION, sidebar: { ...DEFAULT_SESSION.sidebar } };
  }
}

export function saveSession(session: Session): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ ...session, recent: session.recent.slice(0, MAX_RECENT) }));
  } catch {
    // Quota or private-mode failures are not worth interrupting the user for.
  }
}

export function clampZoom(scale: unknown): number {
  const n = typeof scale === "number" && Number.isFinite(scale) ? scale : DEFAULT_SESSION.zoom;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(n * 100) / 100));
}

export function clampWidth(width: unknown): number {
  const n = typeof width === "number" && Number.isFinite(width) ? width : DEFAULT_SESSION.sidebar.width;
  return Math.min(480, Math.max(180, Math.round(n)));
}

export function pushRecent(recent: string[], path: string): string[] {
  return [path, ...recent.filter((p) => p !== path)].slice(0, MAX_RECENT);
}
