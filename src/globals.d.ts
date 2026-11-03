declare module "markdown-it-footnote" {
  import type MarkdownIt from "markdown-it";
  const plugin: MarkdownIt.PluginSimple;
  export default plugin;
}

declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";
  const plugin: (md: MarkdownIt, options?: { enabled?: boolean; label?: boolean; labelAfter?: boolean }) => void;
  export default plugin;
}

declare module "markdown-it-anchor" {
  import type MarkdownIt from "markdown-it";
  const plugin: (
    md: MarkdownIt,
    options?: {
      level?: number | number[];
      permalink?: unknown;
      slugify?: (title: string) => string;
      uniqueSlugStartIndex?: number;
      tabIndex?: number | false;
    },
  ) => void;
  export default plugin;
}

declare module "highlight.js/lib/common" {
  interface HighlightResult {
    value: string;
  }
  interface HLJSApi {
    getLanguage(name: string): unknown;
    highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): HighlightResult;
  }
  const hljs: HLJSApi;
  export default hljs;
}
