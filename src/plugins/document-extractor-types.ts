/** Image extracted from a document page. */
export type DocumentExtractedImage = {
  type: "image";
  data: string;
  mimeType: string;
};

/** Bounded completeness facts recorded by the document extractor that observed them. */
export type DocumentExtractionMetadata = {
  pages?: {
    processed: number[];
    total: number;
    selection: "automatic" | "explicit";
    truncated: boolean;
  };
  textTruncated: boolean;
  imagesTruncated: boolean;
};

/** Request passed to plugin document extractors. */
export type DocumentExtractionRequest = {
  buffer: Buffer;
  mimeType: string;
  maxPages: number;
  maxPixels: number;
  minTextChars: number;
  password?: string;
  pageNumbers?: number[];
  onImageExtractionError?: (error: unknown) => void;
};

/** Text and image result returned by a document extractor. */
export type DocumentExtractionResult = {
  text: string;
  images: DocumentExtractedImage[];
  metadata?: DocumentExtractionMetadata;
};

/** Plugin document extractor capability contract. */
export type DocumentExtractorPlugin = {
  id: string;
  label: string;
  mimeTypes: readonly string[];
  autoDetectOrder?: number;
  extract: (request: DocumentExtractionRequest) => Promise<DocumentExtractionResult | null>;
};

/** Registered document extractor with owning plugin id. */
export type PluginDocumentExtractorEntry = DocumentExtractorPlugin & {
  pluginId: string;
};
