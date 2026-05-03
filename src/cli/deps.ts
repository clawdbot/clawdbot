import type { OutboundSendDeps } from "../infra/outbound/send-deps.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import type { CliDeps } from "./deps.types.js";
import {
  CLI_OUTBOUND_SEND_FACTORY,
  createOutboundSendDepsFromCliSource,
} from "./outbound-send-mapping.js";

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

const NON_CHANNEL_DEP_KEYS = new Set([
  "__proto__",
  "constructor",
  "cron",
  "cronConfig",
  "cronEnabled",
  "defaultAgentId",
  "enqueueSystemEvent",
  "getQueueSize",
  "hasOwnProperty",
  "inspect",
  "log",
  "migrateOrphanedSessionKeys",
  "nowMs",
  "onEvent",
  "requestHeartbeat",
  "resolveSessionStorePath",
  "runHeartbeatOnce",
  "runIsolatedAgentJob",
  "runtime",
  "sendCronFailureAlert",
  "sessionStorePath",
  "storePath",
  "then",
  "toJSON",
  "toString",
  "valueOf",
]);

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
  const deps: CliDeps = {};
  const resolveSender = (channelId: string) =>
    createLazySender(channelId, async () => {
      const { createChannelOutboundRuntimeSend } =
        await import("./send-runtime/channel-outbound-send.js");
      return {
        runtimeSend: createChannelOutboundRuntimeSend({
          channelId: channelId as import("../channels/plugins/types.public.js").ChannelId,
          unavailableMessage: `${channelId} outbound adapter is unavailable.`,
        }) as RuntimeSend,
      } satisfies RuntimeSendModule;
    });

  Object.defineProperty(deps, CLI_OUTBOUND_SEND_FACTORY, {
    configurable: false,
    enumerable: false,
    value: resolveSender,
    writable: false,
  });

  return new Proxy(deps, {
    get(target, property, receiver) {
      if (typeof property !== "string") {
        return Reflect.get(target, property, receiver);
      }
      const existing = Reflect.get(target, property, receiver);
      if (existing !== undefined || NON_CHANNEL_DEP_KEYS.has(property)) {
        return existing;
      }
      const sender = resolveSender(property);
      Reflect.set(target, property, sender, receiver);
      return sender;
    },
  });
}

export function createOutboundSendDeps(deps: CliDeps): OutboundSendDeps {
  return createOutboundSendDepsFromCliSource(deps);
}
