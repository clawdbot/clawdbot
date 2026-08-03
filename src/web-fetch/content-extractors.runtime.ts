/** Runtime bridge for plugin-provided readable-content extractors used by web fetch. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createConfigScopedPromiseLoader } from "../plugins/plugin-cache-primitives.js";
import type {
  WebContentExtractionResult,
  WebContentExtractMode,
} from "../plugins/web-content-extractor-types.js";
import { resolvePluginWebContentExtractors } from "../plugins/web-content-extractors.runtime.js";

// Runtime loader for plugin-provided readable-content extractors. The loader is
// config-scoped so plugin registry results can be reused within a config view.
const webContentExtractorLoader = createConfigScopedPromiseLoader((config?: OpenClawConfig) =>
  resolvePluginWebContentExtractors(config ? { config } : undefined),
);

/** Runs configured content extractors until one returns readable text. */
export async function extractReadableContent(params: {
  html: string;
  url: string;
  extractMode: WebContentExtractMode;
  config?: OpenClawConfig;
}): Promise<(WebContentExtractionResult & { extractor: string }) | null> {
  let extractors: Awaited<ReturnType<typeof webContentExtractorLoader.load>>;
  try {
    extractors = await webContentExtractorLoader.load(params.config);
  } catch {
    return null;
  }

  for (const extractor of extractors) {
    let result: WebContentExtractionResult | null | undefined;
    try {
      result = await extractor.extract({
        html: params.html,
        url: params.url,
        extractMode: params.extractMode,
      });
    } catch {
      // Extraction is best-effort across plugins; one broken extractor should
      // not prevent later extractors from handling the page.
      continue;
    }
    if (result?.text) {
      return {
        ...result,
        extractor: extractor.id,
      };
    }
  }
  return null;
}
