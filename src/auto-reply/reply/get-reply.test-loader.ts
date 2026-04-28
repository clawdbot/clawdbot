import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";

type GetReplyModule = typeof import("./get-reply.js");
type ReplyModule = typeof import("../reply.js");

const cachedGetReplyModulePromises = new Map<string, Promise<GetReplyModule>>();
const cachedReplyModulePromises = new Map<string, Promise<ReplyModule>>();

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

export async function loadReplyModuleForTest(options?: {
  cacheKey?: string;
  fresh?: boolean;
}): Promise<ReplyModule> {
  if (options?.fresh) {
    return await importFreshModule<ReplyModule>(import.meta.url, "../reply.js");
  }
  const cacheKey = options?.cacheKey ?? import.meta.url;
  let cached = cachedReplyModulePromises.get(cacheKey);
  if (!cached) {
    cached = import("../reply.js");
    cachedReplyModulePromises.set(cacheKey, cached);
  }
  return await cached;
}
