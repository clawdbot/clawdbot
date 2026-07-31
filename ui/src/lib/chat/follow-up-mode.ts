import { normalizeQueueMode } from "../../../../src/auto-reply/reply/queue/normalize.js";
import type { QueueMode } from "../../../../src/auto-reply/reply/queue/types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../../../src/utils/message-channel-constants.js";
import { normalizeChatFollowUpModeOverride, type ChatFollowUpMode } from "../../app/settings.js";

export type ControlUiFollowUpMode = ChatFollowUpMode | Exclude<QueueMode, "steer">;

type ServerQueueModeSources = {
  configNeedsApply?: boolean;
  effectiveMode?: unknown;
  sessionMetadataLoaded?: boolean;
  sessionMode?: unknown;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizedQueueMode(value: unknown): QueueMode | undefined {
  return typeof value === "string" ? normalizeQueueMode(value) : undefined;
}

/** Matches resolveQueueSettings precedence for the current Control UI session. */
export function resolveControlUiServerQueueMode(
  runtimeConfig: unknown,
  sources: ServerQueueModeSources = {},
): QueueMode | undefined {
  const config = record(runtimeConfig);
  const messages = record(config?.messages);
  const queue = record(messages?.queue);
  const byChannel = record(queue?.byChannel);
  const configuredMode =
    normalizedQueueMode(byChannel?.[INTERNAL_MESSAGE_CHANNEL]) ?? normalizedQueueMode(queue?.mode);
  const effectiveMode = normalizedQueueMode(sources.effectiveMode);
  const sessionMode = normalizedQueueMode(sources.sessionMode);
  if (sessionMode) {
    return sessionMode;
  }
  // A saved-but-unapplied snapshot is not runtime truth. Until the Gateway's
  // effective projection arrives, omit queueMode and let chat.send resolve it.
  if (sources.configNeedsApply) {
    return effectiveMode;
  }
  if (sources.sessionMetadataLoaded === false && !effectiveMode) {
    return undefined;
  }
  if (!config && !effectiveMode) {
    return undefined;
  }
  return configuredMode ?? effectiveMode ?? "steer";
}

/** Explicit browser choice wins; otherwise preserve the Gateway's full queue semantics. */
export function resolveControlUiFollowUpMode(
  override: unknown,
  serverMode: QueueMode | undefined,
): ControlUiFollowUpMode | undefined {
  return normalizeChatFollowUpModeOverride(override) ?? serverMode;
}
