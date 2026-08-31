import { resolveStateDir } from "../../config/paths.js";
import type { PluginRuntime } from "./types.js";

function unavailable(method: string): () => never {
  return () => {
    throw new Error(`${method} is only available through the plugin runtime proxy.`);
  };
}

/** The registry proxy grants storage; the base runtime never grants it directly. */
export function createRuntimeState(): PluginRuntime["state"] {
  return {
    resolveStateDir,
    openBlobStore: unavailable("openBlobStore"),
    openKeyedStore: unavailable("openKeyedStore"),
    openSyncKeyedStore: unavailable("openSyncKeyedStore"),
    openChannelIngressQueue: unavailable("openChannelIngressQueue"),
    openChannelIngressDrain: unavailable("openChannelIngressDrain"),
  };
}
