import { listChannelPlugins } from "../channels/plugins/index.js";
import type { OutboundSendDeps } from "../infra/outbound/send-deps.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import type { CliDeps } from "./deps.types.js";
import { createOutboundSendDepsFromCliSource } from "./outbound-send-mapping.js";
import { createChannelOutboundRuntimeSend } from "./send-runtime/channel-outbound-send.js";

/**
 * Lazy-loaded per-channel send functions, keyed by channel ID.
 * Values are proxy functions that dynamically import the real module on first use.
 */
export type { CliDeps } from "./deps.types.js";
type RuntimeSend = {
  sendMessage: (...args: unknown[]) => Promise<unknown>;
};
type RuntimeSendModule = {
  runtimeSend: RuntimeSend;
};

// Per-channel module caches for lazy loading.
const senderCache = new Map<string, Promise<RuntimeSend>>();

/**
 * Create a lazy-loading send function proxy for a channel.
 * The channel's module is loaded on first call and cached for reuse.
 */
function createLazySender(
  channelId: string,
  loader: () => Promise<RuntimeSendModule>,
): (...args: unknown[]) => Promise<unknown> {
  const loadRuntimeSend = createLazyRuntimeSurface(loader, ({ runtimeSend }) => runtimeSend);
  return async (...args: unknown[]) => {
    let cached = senderCache.get(channelId);
    if (!cached) {
      cached = loadRuntimeSend();
      senderCache.set(channelId, cached);
    }
    const runtimeSend = await cached;
    return await runtimeSend.sendMessage(...args);
  };
}

export function createDefaultDeps(): CliDeps {
  // Keep the default dependency barrel limited to lazy senders so callers that
  // only need outbound deps do not pull channel runtime boundaries on import.
  const deps: CliDeps = {};
  for (const plugin of listChannelPlugins()) {
    deps[plugin.id] = createLazySender(
      plugin.id,
      async () =>
        ({
          runtimeSend: createChannelOutboundRuntimeSend({
            channelId: plugin.id,
            unavailableMessage: `${plugin.meta.label ?? plugin.id} outbound adapter is unavailable.`,
          }) as RuntimeSend,
        }) satisfies RuntimeSendModule,
    );
  }
  return deps;
}

export function createOutboundSendDeps(deps: CliDeps): OutboundSendDeps {
  return createOutboundSendDepsFromCliSource(deps);
}
