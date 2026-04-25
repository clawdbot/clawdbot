export type WebContentExtractMode = "markdown" | "text";

export type WebContentExtractionRequest = {
  html: string;
  url: string;
  extractMode: WebContentExtractMode;
};

export type WebContentExtractionResult = {
  text: string;
  title?: string;
};

export type WebContentExtractorPlugin = {
  id: string;
  label: string;
  autoDetectOrder?: number;
  extract: (request: WebContentExtractionRequest) => Promise<WebContentExtractionResult | null>;
};

export type PluginWebContentExtractorEntry = WebContentExtractorPlugin & {
  pluginId: string;
};
