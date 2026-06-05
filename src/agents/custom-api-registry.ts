/**
 * Registers caller-supplied custom API stream functions with the LLM registry.
 */
import { getApiProvider, registerApiProvider } from "../llm/api-registry.js";
import type { Api, StreamOptions } from "../llm/types.js";
import type { StreamFn } from "./runtime/index.js";

const CUSTOM_API_SOURCE_PREFIX = "openclaw-custom-api:";

/** Returns the registry source id used for a custom API stream function. */
export function getCustomApiRegistrySourceId(api: Api): string {
  return `${CUSTOM_API_SOURCE_PREFIX}${api}`;
}

/** Registers a custom API stream function when no provider already owns it. */
export function ensureCustomApiRegistered(api: Api, streamFn: StreamFn): boolean {
  if (getApiProvider(api)) {
    return false;
  }

  registerApiProvider(
    {
      api,
      stream: (model, context, options) =>
        streamFn(model, context, options) as unknown as ReturnType<
          NonNullable<ReturnType<typeof getApiProvider>>["stream"]
        >,
      streamSimple: (model, context, options) =>
        streamFn(model, context, options as StreamOptions) as unknown as ReturnType<
          NonNullable<ReturnType<typeof getApiProvider>>["stream"]
        >,
    },
    getCustomApiRegistrySourceId(api),
  );
  return true;
}
