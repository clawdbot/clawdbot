/**
 * Limits embedded-agent history length from session-key policy.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AgentMessage } from "../runtime/index.js";

const THREAD_SUFFIX_REGEX = /^(.*)(?::(?:thread|topic):\d+)$/i;

function stripThreadSuffix(value: string): string {
  const match = value.match(THREAD_SUFFIX_REGEX);
  return match?.[1] ?? value;
}

/**
 * Limits conversation history to the last N user turns (and their associated
 * assistant responses). This reduces token usage for long-running DM sessions.
 *
 * Leading non-conversation messages (e.g. compactionSummary, branchSummary)
 * placed at index 0 by buildSessionContext are always preserved, since they
 * carry summarized pre-compaction context that history limiting must not drop.
 */
export function limitHistoryTurns(
  messages: AgentMessage[],
  limit: number | undefined,
): AgentMessage[] {
  if (!limit || limit <= 0 || messages.length === 0) {
    return messages;
  }

  // Preserve leading non-conversation messages (compactionSummary, branchSummary, etc.)
  // that buildSessionContext places at index 0 to carry pre-compaction context.
  let conversationStart = 0;
  while (conversationStart < messages.length) {
    const role = messages.at(conversationStart)?.role;
    if (role === "user" || role === "assistant") {
      break;
    }
    conversationStart++;
  }

  const tail = messages.slice(conversationStart);
  if (tail.length === 0) {
    return messages;
  }

  let userCount = 0;
  let lastUserIndex = tail.length;

  for (const [i, message] of Array.from(tail.entries()).toReversed()) {
    if (message.role === "user") {
      userCount++;
      if (userCount > limit) {
        return [...messages.slice(0, conversationStart), ...tail.slice(lastUserIndex)];
      }
      lastUserIndex = i;
    }
  }
  return messages;
}

/**
 * Extract provider + user ID from a session key and look up dmHistoryLimit.
 * Supports per-DM overrides and provider defaults.
 * For channel/group sessions, uses historyLimit from provider config.
 */
export function getHistoryLimitFromSessionKey(
  sessionKey: string | undefined,
  config: OpenClawConfig | undefined,
): number | undefined {
  if (!sessionKey || !config) {
    return undefined;
  }

  const parts = sessionKey.split(":").filter(Boolean);
  const providerParts = parts.length >= 3 && parts[0] === "agent" ? parts.slice(2) : parts;

  const provider = normalizeProviderId(providerParts[0] ?? "");
  if (!provider) {
    return undefined;
  }

  const kind = normalizeOptionalLowercaseString(providerParts[1]);
  const userIdRaw = providerParts.slice(2).join(":");
  const userId = stripThreadSuffix(userIdRaw);

  const resolveProviderConfig = (
    cfg: OpenClawConfig | undefined,
    providerId: string,
  ):
    | {
        historyLimit?: number;
        dmHistoryLimit?: number;
        dms?: Record<string, { historyLimit?: number }>;
      }
    | undefined => {
    const channels = cfg?.channels;
    if (!channels || typeof channels !== "object") {
      return undefined;
    }
    for (const [configuredProviderId, value] of Object.entries(
      channels as Record<string, unknown>,
    )) {
      if (normalizeProviderId(configuredProviderId) !== providerId) {
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
      }
      return value as {
        historyLimit?: number;
        dmHistoryLimit?: number;
        dms?: Record<string, { historyLimit?: number }>;
      };
    }
    return undefined;
  };

  const providerConfig = resolveProviderConfig(config, provider);
  if (!providerConfig) {
    return undefined;
  }

  // For DM sessions: per-DM override -> dmHistoryLimit.
  // Accept both "direct" (new) and "dm" (legacy) for backward compat.
  if (kind === "dm" || kind === "direct") {
    if (userId && providerConfig.dms?.[userId]?.historyLimit !== undefined) {
      return providerConfig.dms[userId].historyLimit;
    }
    return providerConfig.dmHistoryLimit;
  }

  // For channel/group sessions: use historyLimit from provider config
  // This prevents context overflow in long-running channel sessions
  if (kind === "channel" || kind === "group") {
    return providerConfig.historyLimit;
  }

  return undefined;
}
