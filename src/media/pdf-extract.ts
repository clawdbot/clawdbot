import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  DocumentExtractedImage,
  DocumentExtractionResult,
} from "../plugins/document-extractor-types.js";
import { extractDocumentContent } from "./document-extractors.runtime.js";

export type PdfExtractedImage = DocumentExtractedImage;
export type PdfExtractedContent = DocumentExtractionResult;

export async function extractPdfContent(params: {
  buffer: Buffer;
  maxPages: number;
  maxPixels: number;
  minTextChars: number;
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
