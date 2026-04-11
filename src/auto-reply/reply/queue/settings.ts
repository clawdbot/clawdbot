import type { InboundDebounceByProvider } from "../../../config/types.messages.js";
import { normalizeOptionalLowercaseString } from "../../../shared/string-coerce.js";
import { normalizeQueueDropPolicy, normalizeQueueMode } from "./normalize.js";
import { DEFAULT_QUEUE_CAP, DEFAULT_QUEUE_DEBOUNCE_MS, DEFAULT_QUEUE_DROP } from "./state.js";
import type { QueueMode, QueueSettings, ResolveQueueSettingsParams } from "./types.js";

function defaultQueueModeForChannel(_channel?: string): QueueMode {
  return "collect";
}

/** Resolve per-channel debounce override from debounceMsByChannel map. */
function resolveChannelDebounce(
  byChannel: InboundDebounceByProvider | undefined,
  channelKey: string | undefined,
): number | undefined {
  if (!channelKey || !byChannel) {
    return undefined;
  }
  const value = byChannel[channelKey];
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

export function resolveQueueSettings(params: ResolveQueueSettingsParams): QueueSettings {
  const channelKey = normalizeOptionalLowercaseString(params.channel);
  const queueCfg = params.cfg.messages?.queue;
  const providerModeRaw =
    channelKey && queueCfg?.byChannel
      ? (queueCfg.byChannel as Record<string, string | undefined>)[channelKey]
      : undefined;
  const resolvedMode =
    params.inlineMode ??
    normalizeQueueMode(params.sessionEntry?.queueMode) ??
    normalizeQueueMode(providerModeRaw) ??
    normalizeQueueMode(queueCfg?.mode) ??
    defaultQueueModeForChannel(channelKey);
  const debounceRaw =
    params.inlineOptions?.debounceMs ??
    params.sessionEntry?.queueDebounceMs ??
    resolveChannelDebounce(queueCfg?.debounceMsByChannel, channelKey) ??
    params.pluginDebounceMs ??
    queueCfg?.debounceMs ??
    DEFAULT_QUEUE_DEBOUNCE_MS;
  const capRaw =
    params.inlineOptions?.cap ??
    params.sessionEntry?.queueCap ??
    queueCfg?.cap ??
    DEFAULT_QUEUE_CAP;
  const dropRaw =
    params.inlineOptions?.dropPolicy ??
    params.sessionEntry?.queueDrop ??
    normalizeQueueDropPolicy(queueCfg?.drop) ??
    DEFAULT_QUEUE_DROP;
  return {
    mode: resolvedMode,
    debounceMs: typeof debounceRaw === "number" ? Math.max(0, debounceRaw) : undefined,
    cap: typeof capRaw === "number" ? Math.max(1, Math.floor(capRaw)) : undefined,
    dropPolicy: dropRaw,
  };
}
