import { resolveStateDir } from "../../config/paths.js";
import { createRuntimeConfig } from "./runtime-config.js";
import { createRuntimeSystem } from "./runtime-system.js";
import type { PluginRuntime } from "./types.js";

function unavailable(method: string): () => never {
  return () => {
    throw new Error(`${method} is only available through the plugin runtime proxy.`);
  };
}

/** Host-owned facades survive later path-loaded runtime materialization unchanged. */
export function createRuntimeBase(): Pick<PluginRuntime, "config" | "state" | "system"> {
  let system: PluginRuntime["system"] | undefined;
  return {
    config: createRuntimeConfig(),
    // Only the registry proxy grants storage, never the base runtime directly.
    state: {
      resolveStateDir,
      openBlobStore: unavailable("openBlobStore"),
      openKeyedStore: unavailable("openKeyedStore"),
      openSyncKeyedStore: unavailable("openSyncKeyedStore"),
      openChannelIngressQueue: unavailable("openChannelIngressQueue"),
      openChannelIngressDrain: unavailable("openChannelIngressDrain"),
    },
    get system() {
      return (system ??= createRuntimeSystem());
    },
  };
}
