// PDF extraction helpers read PDF text through configured document extraction.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  DocumentExtractedImage,
  DocumentExtractionResult,
} from "../plugins/document-extractor-types.js";
import { extractDocumentContent } from "./document-extractors.runtime.js";

/** Image payload extracted from a PDF page by the document-extract plugin. */
export type PdfExtractedImage = DocumentExtractedImage;
/** Text and extracted image payloads returned by PDF extraction callers. */
export type PdfExtractedContent = DocumentExtractionResult;

/** Extracts PDF content through the configured document extractor and hides extractor metadata. */
export async function extractPdfContent(params: {
  buffer: Buffer;
  maxPages: number;
  maxPixels: number;
  minTextChars: number;
  password?: string;
  pageNumbers?: number[];
  config?: OpenClawConfig;
  onImageExtractionError?: (error: unknown) => void;
}): Promise<PdfExtractedContent> {
  const extracted = await extractDocumentContent({
    buffer: params.buffer,
    mimeType: "application/pdf",
    maxPages: params.maxPages,
    maxPixels: params.maxPixels,
    minTextChars: params.minTextChars,
    ...(params.password ? { password: params.password } : {}),
    ...(params.pageNumbers ? { pageNumbers: params.pageNumbers } : {}),
    ...(params.config ? { config: params.config } : {}),
    ...(params.onImageExtractionError
      ? { onImageExtractionError: params.onImageExtractionError }
      : {}),
  });
  if (!extracted) {
    throw new Error(
      "PDF extraction disabled or unavailable: enable the document-extract plugin to process application/pdf files.",
    );
  }
  return {
    text: extracted.text,
    images: extracted.images,
  };
}
