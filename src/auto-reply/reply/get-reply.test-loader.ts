import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";

type GetReplyModule = typeof import("./get-reply.js");

const cachedGetReplyModulePromises = new Map<string, Promise<GetReplyModule>>();

/**
 * Default to cached module loads for reply tests.
 * Fresh imports are expensive here because get-reply pulls a large runtime graph.
 */
export async function loadGetReplyModuleForTest(options?: {
  cacheKey?: string;
  fresh?: boolean;
}): Promise<GetReplyModule> {
  if (options?.fresh) {
    return await importFreshModule<GetReplyModule>(import.meta.url, "./get-reply.js");
  }
  const cacheKey = options?.cacheKey ?? import.meta.url;
  let cached = cachedGetReplyModulePromises.get(cacheKey);
  if (!cached) {
    cached = import("./get-reply.js");
    cachedGetReplyModulePromises.set(cacheKey, cached);
  }
  return await cached;
}
