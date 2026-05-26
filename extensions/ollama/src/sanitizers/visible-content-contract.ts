export type OllamaVisibleContentStreamResolution =
  | { kind: "visible"; text: string }
  | { kind: "pending" };

export type OllamaVisibleContentSanitizer = {
  resolveStreamText(params: { text: string; final: boolean }): OllamaVisibleContentStreamResolution;
  sanitizeFinalText(text: string): string;
};
