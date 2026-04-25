import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  WebContentExtractionResult,
  WebContentExtractMode,
} from "../plugins/web-content-extractor-types.js";
import { resolvePluginWebContentExtractors } from "../plugins/web-content-extractors.runtime.js";

let extractorPromise: Promise<ReturnType<typeof resolvePluginWebContentExtractors>> | undefined;
const extractorPromisesByConfig = new WeakMap<
  OpenClawConfig,
  Promise<ReturnType<typeof resolvePluginWebContentExtractors>>
>();

async function loadWebContentExtractors(config?: OpenClawConfig) {
  if (config) {
    const cached = extractorPromisesByConfig.get(config);
    if (cached) {
      return await cached;
    }
    const promise = Promise.resolve().then(() => resolvePluginWebContentExtractors({ config }));
    extractorPromisesByConfig.set(config, promise);
    void promise.catch(() => {
      extractorPromisesByConfig.delete(config);
    });
    return await promise;
  }
  extractorPromise ??= Promise.resolve(resolvePluginWebContentExtractors());
  return await extractorPromise;
}

export async function extractReadableContent(params: {
  html: string;
  url: string;
  extractMode: WebContentExtractMode;
  config?: OpenClawConfig;
}): Promise<(WebContentExtractionResult & { extractor: string }) | null> {
  let extractors: Awaited<ReturnType<typeof loadWebContentExtractors>>;
  try {
    extractors = await loadWebContentExtractors(params.config);
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
