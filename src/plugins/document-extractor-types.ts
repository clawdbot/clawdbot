/** Image extracted from a document page. */
export type DocumentExtractedImage = {
  type: "image";
  data: string;
  mimeType: string;
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
  /** Caller-owned cancellation; presence may select an isolated, terminable extractor path. */
  signal?: AbortSignal;
  onImageExtractionError?: (error: unknown) => void;
};

/** Text and image result returned by a document extractor. */
export type DocumentExtractionResult = {
  text: string;
  images: DocumentExtractedImage[];
};

export const DOCUMENT_EXTRACTOR_CAPACITY_ERROR_CODE = "document_extractor_capacity" as const;

/** Retryable extractor admission failure that callers may map at an HTTP boundary. */
export type DocumentExtractorCapacityError = Error & {
  readonly code: typeof DOCUMENT_EXTRACTOR_CAPACITY_ERROR_CODE;
};

export function createDocumentExtractorCapacityError(
  message: string,
): DocumentExtractorCapacityError {
  return Object.assign(new Error(message), {
    name: "DocumentExtractorCapacityError",
    code: DOCUMENT_EXTRACTOR_CAPACITY_ERROR_CODE,
  });
}

/** Structural guard remains stable when plugin and host load separate SDK module instances. */
export function isDocumentExtractorCapacityError(
  value: unknown,
): value is DocumentExtractorCapacityError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { code?: unknown }).code === DOCUMENT_EXTRACTOR_CAPACITY_ERROR_CODE
  );
}

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
