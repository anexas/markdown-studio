import type { ViewMode } from "./types";

const PREFS_KEY = "markdown-studio.prefs.v1";

/**
 * Startup defaults, deliberately kept apart from the session: the session records what
 * you were doing last time, preferences record how the app should always open. Until a
 * preference has been saved the session still wins, so upgrading changes nothing.
 */
export interface Prefs {
  /** Folder the sidebar opens at startup; null reuses the last session's folder. */
  homeFolder: string | null;
  defaultMode: ViewMode;
  sidebarVisible: boolean;
  /** Save existing files shortly after typing stops, without a dialog. */
  autosave: boolean;
  /** Stylesheet applied to the preview, rendered pane and HTML export. */
  customCss: string | null;
}

export const DEFAULT_PREFS: Prefs = {
  homeFolder: null,
  defaultMode: "split",
  sidebarVisible: false,
  autosave: true,
  customCss: null,
};

/** True once the user has saved the dialog at least once. */
export function hasPrefs(): boolean {
  try {
    return localStorage.getItem(PREFS_KEY) !== null;
  } catch {
    return false;
  }
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      homeFolder: typeof parsed.homeFolder === "string" && parsed.homeFolder.trim() ? parsed.homeFolder : null,
      defaultMode: parsed.defaultMode === "raw" || parsed.defaultMode === "preview" ? parsed.defaultMode : "split",
      sidebarVisible: parsed.sidebarVisible === true,
      // Absent in preferences saved before autosave existed: those users get it turned on.
      autosave: parsed.autosave !== false,
      customCss: typeof parsed.customCss === "string" && parsed.customCss.trim() ? parsed.customCss : null,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Quota or private-mode failures must not interrupt the user.
  }
}
