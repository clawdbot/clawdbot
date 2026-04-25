export type DocumentExtractedImage = {
  type: "image";
  data: string;
  mimeType: string;
};

export type DocumentExtractionRequest = {
  buffer: Buffer;
  mimeType: string;
  maxPages: number;
  maxPixels: number;
  minTextChars: number;
  pageNumbers?: number[];
  onImageExtractionError?: (error: unknown) => void;
};

export type DocumentExtractionResult = {
  text: string;
  images: DocumentExtractedImage[];
};

export type DocumentExtractorPlugin = {
  id: string;
  label: string;
  mimeTypes: readonly string[];
  autoDetectOrder?: number;
  extract: (request: DocumentExtractionRequest) => Promise<DocumentExtractionResult | null>;
};

export type PluginDocumentExtractorEntry = DocumentExtractorPlugin & {
  pluginId: string;
};
