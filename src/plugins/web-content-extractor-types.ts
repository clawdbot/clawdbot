/** Web content extraction mode requested from extractor plugins. */
export type WebContentExtractMode = "markdown" | "text";

/** Request passed to a web content extractor plugin. */
export type WebContentExtractionRequest = {
  html: string;
  url: string;
  extractMode: WebContentExtractMode;
};

/** Result returned by a web content extractor plugin. */
export type WebContentExtractionResult = {
  text: string;
  title?: string;
};

/** Web content extractor plugin contract. */
export type WebContentExtractorPlugin = {
  id: string;
  label: string;
  autoDetectOrder?: number;
  extract: (request: WebContentExtractionRequest) => Promise<WebContentExtractionResult | null>;
};

/** Registered web content extractor with owning plugin metadata. */
export type PluginWebContentExtractorEntry = WebContentExtractorPlugin & {
  pluginId: string;
};
