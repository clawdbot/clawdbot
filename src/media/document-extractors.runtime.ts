// Document extractor runtime helpers choose lazy extraction adapters by media type.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { z } from "zod";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  DocumentExtractionRequest,
  DocumentExtractionResult,
} from "../plugins/document-extractor-types.js";
import { resolvePluginDocumentExtractors } from "../plugins/document-extractors.runtime.js";
import { createConfigScopedPromiseLoader } from "../plugins/plugin-cache-primitives.js";

const documentExtractorLoader = createConfigScopedPromiseLoader((config?: OpenClawConfig) =>
  resolvePluginDocumentExtractors(config ? { config } : undefined),
);
const extractionIntegerSchema = z.number().int().max(Number.MAX_SAFE_INTEGER);
const extractionMetadataSchema = z.object({
  pages: z
    .object({
      processed: z.array(extractionIntegerSchema.positive()),
      total: extractionIntegerSchema.nonnegative(),
      selection: z.enum(["automatic", "explicit"]),
      truncated: z.boolean(),
    })
    .optional(),
  textTruncated: z.boolean(),
  imagesTruncated: z.boolean(),
});

/** Runs the first matching plugin document extractor and tags successful results with its extractor id. */
export async function extractDocumentContent(
  params: DocumentExtractionRequest & {
    config?: OpenClawConfig;
  },
): Promise<(DocumentExtractionResult & { extractor: string }) | null> {
  const mimeType = normalizeLowercaseStringOrEmpty(params.mimeType);
  const extractors = await documentExtractorLoader.load(params.config);
  // Keep config and loader-only fields out of plugin calls; extractors receive the SDK request shape.
  const request: DocumentExtractionRequest = {
    buffer: params.buffer,
    mimeType: params.mimeType,
    maxPages: params.maxPages,
    maxPixels: params.maxPixels,
    minTextChars: params.minTextChars,
    ...(params.password ? { password: params.password } : {}),
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
        const { metadata, ...content } = result;
        const validatedMetadata = extractionMetadataSchema.safeParse(metadata);
        const parsedMetadata = validatedMetadata.success ? validatedMetadata.data : undefined;
        const pages = parsedMetadata?.pages;
        const selectedPages = request.pageNumbers
          ? request.pageNumbers
              .filter((page) => pages && Number.isInteger(page) && page >= 1 && page <= pages.total)
              .slice(0, request.maxPages)
          : Array.from(
              { length: Math.min(pages?.total ?? 0, request.maxPages) },
              (_, index) => index + 1,
            );
        const selectedPageSet = new Set(selectedPages);
        const expectedPageTruncation = request.pageNumbers
          ? request.pageNumbers.length > selectedPages.length
          : (pages?.total ?? 0) > request.maxPages;
        // Completeness metadata becomes trusted prompt text; bind page claims to the
        // request that produced them so plugin output cannot fabricate a notice.
        const trustedMetadata =
          parsedMetadata &&
          (!pages ||
            (pages.selection === (request.pageNumbers ? "explicit" : "automatic") &&
              pages.processed.length <= request.maxPages &&
              new Set(pages.processed).size === pages.processed.length &&
              pages.processed.every((page) => page <= pages.total && selectedPageSet.has(page)) &&
              pages.truncated === expectedPageTruncation &&
              (parsedMetadata.textTruncated || pages.processed.length === selectedPageSet.size)))
            ? parsedMetadata
            : undefined;
        return {
          ...content,
          ...(trustedMetadata ? { metadata: trustedMetadata } : {}),
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
