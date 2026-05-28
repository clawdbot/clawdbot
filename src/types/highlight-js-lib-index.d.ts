declare module "highlight.js/lib/index.js" {
  interface HighlightResult {
    value: string;
  }

  interface HighlightOptions {
    language: string;
    ignoreIllegals?: boolean;
  }

  interface HighlightJs {
    highlight(code: string, options: HighlightOptions): HighlightResult;
    highlightAuto(code: string, languageSubset?: string[]): HighlightResult;
    getLanguage(name: string): unknown;
  }

  const hljs: HighlightJs;
  export default hljs;
}
