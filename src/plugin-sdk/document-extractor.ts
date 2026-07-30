/**
 * Public SDK surface for document extractor plugins.
 */
export {
  createDocumentExtractorCapacityError,
  DOCUMENT_EXTRACTOR_CAPACITY_ERROR_CODE,
  isDocumentExtractorCapacityError,
} from "../plugins/document-extractor-types.js";
export type {
  DocumentExtractedImage,
  DocumentExtractorCapacityError,
  DocumentExtractionRequest,
  DocumentExtractionResult,
  DocumentExtractorPlugin,
} from "../plugins/document-extractor-types.js";
