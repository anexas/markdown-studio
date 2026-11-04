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
}

export const DEFAULT_PREFS: Prefs = {
  homeFolder: null,
  defaultMode: "split",
  sidebarVisible: false,
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
