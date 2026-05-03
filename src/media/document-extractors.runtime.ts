import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  DocumentExtractionRequest,
  DocumentExtractionResult,
} from "../plugins/document-extractor-types.js";
import { resolvePluginDocumentExtractors } from "../plugins/document-extractors.runtime.js";
import { createConfigScopedPromiseLoader } from "../plugins/plugin-cache-primitives.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

const documentExtractorLoader = createConfigScopedPromiseLoader((config?: OpenClawConfig) =>
  resolvePluginDocumentExtractors(config ? { config } : undefined),
);

export async function extractDocumentContent(
  params: DocumentExtractionRequest & {
    config?: OpenClawConfig;
  },
): Promise<(DocumentExtractionResult & { extractor: string }) | null> {
  const mimeType = normalizeLowercaseStringOrEmpty(params.mimeType);
  const extractors = await documentExtractorLoader.load(params.config);
  const request: DocumentExtractionRequest = {
    buffer: params.buffer,
    mimeType: params.mimeType,
    maxPages: params.maxPages,
    maxPixels: params.maxPixels,
    minTextChars: params.minTextChars,
    ...(params.pageNumbers ? { pageNumbers: params.pageNumbers } : {}),
    ...(params.onImageExtractionError
      ? { onImageExtractionError: params.onImageExtractionError }
      : {}),
  };
  const errors: unknown[] = [];

  for (const extractor of extractors) {
    if (
      !extractor.mimeTypes.map((entry) => normalizeLowercaseStringOrEmpty(entry)).includes(mimeType)
    ) {
      continue;
    }
    try {
      const result = await extractor.extract(request);
      if (result) {
        return {
          ...result,
          extractor: extractor.id,
        };
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Document extraction failed for ${mimeType || "unknown MIME type"}`, {
      cause: errors.length === 1 ? errors[0] : new AggregateError(errors),
    });
  }
  return null;
}
