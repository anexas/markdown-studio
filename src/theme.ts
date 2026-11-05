/**
 * Custom CSS themes.
 *
 * A theme is a user stylesheet applied to the preview, the editable rendered pane and the
 * HTML export. It is loaded through a Rust command that only accepts `.css` files, so a
 * mistake in the preferences dialog cannot pull in a script or a binary as a stylesheet.
 */
import { invoke } from "@tauri-apps/api/core";

const STYLE_ID = "custom-theme";
let applied: string | null = null;

/** Removes the stylesheet currently in effect, if any. */
export function clearCustomCss(): void {
  document.getElementById(STYLE_ID)?.remove();
  applied = null;
}

/**
 * Loads and applies a theme file. Returns an error message on failure so the preferences
 * dialog can report it; the previous theme stays in effect meanwhile.
 */
export async function applyCustomCss(path: string | null): Promise<string | null> {
  if (!path) {
    clearCustomCss();
    return null;
  }

  try {
    const css = await invoke<string>("read_stylesheet", { path });
    let tag = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!tag) {
      tag = document.createElement("style");
      tag.id = STYLE_ID;
      // Appended last so a theme can override the built-in chrome without !important.
      document.head.append(tag);
    }
    tag.textContent = css;
    applied = css;
    return null;
  } catch (err) {
    return String(err);
  }
}

/** Stylesheet text for the HTML export, so the page keeps the theme it was written in. */
export function customCssText(): string {
  return applied ?? "";
}
