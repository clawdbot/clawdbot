import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeOptionalString, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  ACTIVE_MEMORY_DEBUG_PREFIX,
  ACTIVE_MEMORY_STATUS_PREFIX,
  type ActiveMemorySearchDebug,
  type ActiveRecallResult,
  type PluginDebugEntry,
  type ResolvedActiveRecallPluginConfig,
} from "./types.js";

function resolveCanonicalSessionKeyFromSessionId(params: {
  api: OpenClawPluginApi;
  agentId: string;
  sessionId?: string;
}): string | undefined {
  const sessionId = params.sessionId?.trim();
  if (!sessionId) {
    return undefined;
  }
  try {
    let bestMatch:
      | {
          sessionKey: string;
          updatedAt: number;
        }
      | undefined;
    for (const { sessionKey, entry } of params.api.runtime.agent.session.listSessionEntries({
      agentId: params.agentId,
      readOnly: true,
    })) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const candidateSessionId =
        typeof (entry as { sessionId?: unknown }).sessionId === "string"
          ? (entry as { sessionId?: string }).sessionId?.trim()
          : "";
      if (!candidateSessionId || candidateSessionId !== sessionId) {
        continue;
      }
      const updatedAt =
        typeof (entry as { updatedAt?: unknown }).updatedAt === "number"
          ? ((entry as { updatedAt?: number }).updatedAt ?? 0)
          : 0;
      if (!bestMatch || updatedAt > bestMatch.updatedAt) {
        bestMatch = { sessionKey, updatedAt };
      }
    }
    return bestMatch?.sessionKey?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function resolveRecallRunChannelContext(params: {
  api: OpenClawPluginApi;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  messageProvider?: string;
  channelId?: string;
}): {
  messageChannel?: string;
  messageProvider?: string;
} {
  const isRunnableChannelName = (channel: string) =>
    !channel.includes(":") && !channel.includes("/");
  const explicitChannel = normalizeOptionalString(params.channelId);
  const explicitProvider = normalizeOptionalString(params.messageProvider);
  // A channelId that contains ":" is a scoped conversation id (e.g. Telegram
  // forum-topic "-100123:topic:77") or "/" (e.g. Google Chat "spaces/...") is
  // not a runnable channel name. Using it as the embedded recall run's channel
  // causes bundled-plugin dirName validation to throw (#76704, #78918).
  const runnableExplicitChannel =
    explicitChannel && isRunnableChannelName(explicitChannel) ? explicitChannel : undefined;
  // Non-webchat providers often pass a raw conversation id as channelId.
  // Keep those ids for filtering, but run the recall sub-agent through the provider.
  const trustedExplicitChannel =
    runnableExplicitChannel &&
    runnableExplicitChannel !== explicitProvider &&
    (!explicitProvider || explicitProvider === "webchat")
      ? runnableExplicitChannel
      : undefined;
  const resolveReturnValue = (paramsLocal: {
    resolvedChannel?: string;
    resolvedChannelStrength?: "strong" | "weak";
  }) => {
    const trustedResolvedChannel =
      paramsLocal.resolvedChannelStrength === "strong" ? paramsLocal.resolvedChannel : undefined;
    return {
      messageChannel:
        trustedExplicitChannel ??
        trustedResolvedChannel ??
        explicitProvider ??
        runnableExplicitChannel ??
        paramsLocal.resolvedChannel,
      messageProvider:
        trustedExplicitChannel ??
        trustedResolvedChannel ??
        explicitProvider ??
        runnableExplicitChannel ??
        paramsLocal.resolvedChannel,
    };
  };
  const resolvedSessionKey =
    normalizeOptionalString(params.sessionKey) ??
    resolveCanonicalSessionKeyFromSessionId({
      api: params.api,
      agentId: params.agentId,
      sessionId: params.sessionId,
    });
  if (!resolvedSessionKey) {
    return resolveReturnValue({});
  }

  try {
    const sessionEntry = params.api.runtime.agent.session.getSessionEntry({
      agentId: params.agentId,
      sessionKey: resolvedSessionKey,
    });
    const rawStrongEntryChannel =
      normalizeOptionalString(sessionEntry?.lastChannel) ??
      normalizeOptionalString(sessionEntry?.channel);
    // Channel IDs containing ":" or "/" are scoped conversation IDs, not
    // runnable channel names. The same guard that
    // applies to explicit channelId (#76704) must also apply to channels
    // read from the session store (#77396).
    const strongEntryChannel =
      rawStrongEntryChannel && isRunnableChannelName(rawStrongEntryChannel)
        ? rawStrongEntryChannel
        : undefined;
    const weakEntryChannel = normalizeOptionalString(sessionEntry?.origin?.provider);
    return resolveReturnValue({
      resolvedChannel: strongEntryChannel ?? weakEntryChannel,
      resolvedChannelStrength: strongEntryChannel
        ? "strong"
        : weakEntryChannel
          ? "weak"
          : undefined,
    });
  } catch {
    return resolveReturnValue({});
  }
}

function resolveStatusUpdateAgentId(ctx: { agentId?: string; sessionKey?: string }): string {
  const explicit = ctx.agentId?.trim();
  if (explicit) {
    return explicit;
  }
  const sessionKey = ctx.sessionKey?.trim();
  if (!sessionKey) {
    return "";
  }
  const match = /^agent:([^:]+):/i.exec(sessionKey);
  return match?.[1]?.trim() ?? "";
}

function formatElapsedMsCompact(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return "0ms";
  }
  if (elapsedMs >= 1000) {
    const seconds = elapsedMs / 1000;
    return `${seconds % 1 === 0 ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
  }
  return `${Math.round(elapsedMs)}ms`;
}

function buildPluginStatusLine(params: {
  result: ActiveRecallResult;
  config: ResolvedActiveRecallPluginConfig;
}): string {
  const parts = [
    ACTIVE_MEMORY_STATUS_PREFIX,
    `status=${params.result.status}`,
    `elapsed=${formatElapsedMsCompact(params.result.elapsedMs)}`,
    `query=${params.config.queryMode}`,
  ];
  if (params.result.summary && params.result.summary.length > 0) {
    parts.push(`summary=${params.result.summary.length} chars`);
  }
  return parts.join(" ");
}

function buildPersistedDebugSummary(result: ActiveRecallResult): string | null {
  if (result.status === "timeout_partial") {
    return `timeout_partial: ${String(result.summary.length)} chars recovered (not persisted)`;
  }
  return result.summary;
}

function buildPluginDebugLine(params: {
  summary?: string | null;
  searchDebug?: ActiveMemorySearchDebug;
}): string | null {
  const cleaned = sanitizeDebugText(params.summary ?? "");
  const warning = sanitizeDebugText(params.searchDebug?.warning ?? "");
  const action = sanitizeDebugText(params.searchDebug?.action ?? "");
  const error = sanitizeDebugText(params.searchDebug?.error ?? "");
  const debugParts: string[] = [];
  const backend = sanitizeDebugText(params.searchDebug?.backend ?? "");
  if (backend) {
    debugParts.push(`backend=${backend}`);
  }
  const configuredMode = sanitizeDebugText(params.searchDebug?.configuredMode ?? "");
  if (configuredMode) {
    debugParts.push(`configuredMode=${configuredMode}`);
  }
  const effectiveMode = sanitizeDebugText(params.searchDebug?.effectiveMode ?? "");
  if (effectiveMode) {
    debugParts.push(`effectiveMode=${effectiveMode}`);
  }
  const fallback = sanitizeDebugText(params.searchDebug?.fallback ?? "");
  if (fallback) {
    debugParts.push(`fallback=${fallback}`);
  }
  if (
    typeof params.searchDebug?.searchMs === "number" &&
    Number.isFinite(params.searchDebug.searchMs)
  ) {
    debugParts.push(`searchMs=${Math.max(0, Math.round(params.searchDebug.searchMs))}`);
  }
  if (typeof params.searchDebug?.hits === "number" && Number.isFinite(params.searchDebug.hits)) {
    debugParts.push(`hits=${Math.max(0, Math.floor(params.searchDebug.hits))}`);
  }
  const prefix = debugParts.join(" ");
  const warningAction =
    warning && action && !cleaned
      ? `${warning} ${action}`
      : [warning, action && !cleaned ? action : ""]
          .filter((value): value is string => Boolean(value))
          .join(" | ");
  const messages = uniqueStrings(
    [warningAction, cleaned].filter((value): value is string => Boolean(value)),
  ).join(" | ");
  const trailing = messages;
  if (prefix && trailing) {
    return `${ACTIVE_MEMORY_DEBUG_PREFIX} ${prefix} | ${trailing}`;
  }
  if (prefix) {
    return `${ACTIVE_MEMORY_DEBUG_PREFIX} ${prefix}`;
  }
  if (messages) {
    return `${ACTIVE_MEMORY_DEBUG_PREFIX} ${messages}`;
  }
  if (warning) {
    return `${ACTIVE_MEMORY_DEBUG_PREFIX} ${warning}`;
  }
  if (cleaned) {
    return `${ACTIVE_MEMORY_DEBUG_PREFIX} ${cleaned}`;
  }
  if (error) {
    return `${ACTIVE_MEMORY_DEBUG_PREFIX} ${error}`;
  }
  return null;
}

function sanitizeDebugText(text: string): string {
  let sanitized = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    const isControl = (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
    if (!isControl) {
      sanitized += ch;
    }
  }
  return sanitized.replace(/\s+/g, " ").trim();
}

async function persistPluginStatusLines(params: {
  api: OpenClawPluginApi;
  agentId: string;
  sessionKey?: string;
  statusLine?: string;
  debugSummary?: string | null;
  searchDebug?: ActiveMemorySearchDebug;
}): Promise<void> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  const debugLine = buildPluginDebugLine({
    summary: params.debugSummary,
    searchDebug: params.searchDebug,
  });
  const agentId = params.agentId.trim();
  if (!agentId && (params.statusLine || debugLine)) {
    return;
  }
  try {
    if (!params.statusLine && !debugLine) {
      const existingEntry = params.api.runtime.agent.session.getSessionEntry({
        agentId,
        sessionKey,
      });
      const hasActiveMemoryEntry = Array.isArray(existingEntry?.pluginDebugEntries)
        ? existingEntry.pluginDebugEntries.some((entry) => entry?.pluginId === "active-memory")
        : false;
      if (!hasActiveMemoryEntry) {
        return;
      }
    }
    await params.api.runtime.agent.session.patchSessionEntry({
      agentId,
      sessionKey,
      preserveActivity: true,
      update: (existing) => {
        const previousEntries = Array.isArray(existing.pluginDebugEntries)
          ? existing.pluginDebugEntries
          : [];
        const nextEntries = previousEntries.filter(
          (entry): entry is PluginDebugEntry =>
            Boolean(entry) &&
            typeof entry === "object" &&
            typeof entry.pluginId === "string" &&
            entry.pluginId !== "active-memory",
        );
        const nextLines: string[] = [];
        if (params.statusLine) {
          nextLines.push(params.statusLine);
        }
        if (debugLine) {
          nextLines.push(debugLine);
        }
        if (nextLines.length > 0) {
          nextEntries.push({
            pluginId: "active-memory",
            lines: nextLines,
          });
        }
        return {
          pluginDebugEntries: nextEntries.length > 0 ? nextEntries : undefined,
        };
      },
    });
  } catch (error) {
    params.api.logger.debug?.(
      `active-memory: failed to persist session status note (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

export {
  buildPersistedDebugSummary,
  buildPluginStatusLine,
  persistPluginStatusLines,
  resolveCanonicalSessionKeyFromSessionId,
  resolveRecallRunChannelContext,
  resolveStatusUpdateAgentId,
};
