import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createConfigScopedPromiseLoader } from "../plugins/plugin-cache-primitives.js";
import type {
  WebContentExtractionResult,
  WebContentExtractMode,
} from "../plugins/web-content-extractor-types.js";
import { resolvePluginWebContentExtractors } from "../plugins/web-content-extractors.runtime.js";

const webContentExtractorLoader = createConfigScopedPromiseLoader((config?: OpenClawConfig) =>
  resolvePluginWebContentExtractors(config ? { config } : undefined),
);

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
