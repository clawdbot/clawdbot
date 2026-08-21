// The gateway's built config schema, memoized between requests.
//
// Ownership of a channel is decided by the config, so this response is config-dependent and cannot
// be keyed on the plugin registry version alone: a `channels.<id>` hot reload changes the answer
// without advancing that version. It lives in its own module so the reload path can invalidate it
// without importing the request handlers.
import type { ConfigSchemaResponse } from "../config/schema.js";

let cache: { pluginRegistryVersion: number; response: ConfigSchemaResponse } | null = null;

export function getCachedConfigSchemaResponse(
  pluginRegistryVersion: number,
): ConfigSchemaResponse | undefined {
  return cache?.pluginRegistryVersion === pluginRegistryVersion ? cache.response : undefined;
}

export function setCachedConfigSchemaResponse(
  pluginRegistryVersion: number,
  response: ConfigSchemaResponse,
): void {
  cache = { pluginRegistryVersion, response };
}

/** Drops the memoized schema. Called for every accepted config candidate, however it arrived. */
export function invalidateConfigSchemaResponseCache(): void {
  cache = null;
}
