/** Relays child ACP session stream updates back into the requester parent session. */
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  isAcpTagVisible,
  resolveAcpProjectionSettings,
  type AcpProjectionSettings,
} from "../auto-reply/reply/acp-stream-settings.js";
import {
  resolveChannelStreamingProgressCommentary,
  type StreamingCompatEntry,
} from "../channels/streaming.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { onAgentEvent } from "../infra/agent-events.js";
import {
  type EventSessionRoutingPolicy,
  resolveEventSessionKeyForPolicy,
  scopedHeartbeatWakeOptionsForPolicy,
} from "../infra/event-session-routing.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveNormalizedAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { normalizeAssistantPhase } from "../shared/chat-message-content.js";
import { recordTaskRunProgressByRunId } from "../tasks/detached-task-runtime.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import {
  recordAcpParentStreamEvents,
  type AcpParentStreamEvent,
} from "./acp-parent-stream-store.sqlite.js";

const DEFAULT_STREAM_FLUSH_MS = 2_500;
const DEFAULT_NO_OUTPUT_NOTICE_MS = 60_000;
const DEFAULT_NO_OUTPUT_POLL_MS = 15_000;
const DEFAULT_MAX_RELAY_LIFETIME_MS = 6 * 60 * 60 * 1000;
const STREAM_BUFFER_MAX_CHARS = 4_000;
const STREAM_SNIPPET_MAX_CHARS = 220;
const STREAM_LOG_BATCH_SIZE = 100;
const STREAM_LOG_FLUSH_MS = 1_000;
const STREAM_LOG_MAX_PENDING_EVENTS = 256;
const STREAM_LOG_MAX_RETRY_MS = 30_000;
const log = createSubsystemLogger("agents/acp-parent-stream");

type AcpParentProgressStreamingConfig = StreamingCompatEntry & {
  accounts?: Record<string, StreamingCompatEntry | undefined>;
};

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 1) {
    return truncateUtf16Safe(value, maxChars);
  }
  return `${truncateUtf16Safe(value, maxChars - 1)}…`;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function formatProxyEnvSummary(keys: string[]): string {
  if (keys.length === 0) {
    return "proxy env: none";
  }
  return `proxy env: ${keys.join(", ")}`;
}

function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStreamingConfigRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asObjectRecord(value);
  if (record) {
    return record;
  }
  if (typeof value === "string") {
    return { mode: value };
  }
  if (typeof value === "boolean") {
    return { mode: value ? "partial" : "off" };
  }
  return undefined;
}

function mergeStreamingConfig(base: unknown, override: unknown): unknown {
  const baseRecord = asStreamingConfigRecord(base);
  const overrideRecord = asStreamingConfigRecord(override);
  if (!baseRecord || !overrideRecord) {
    return override ?? base;
  }
  const merged = {
    ...baseRecord,
    ...overrideRecord,
  };
  const baseProgress = asObjectRecord(baseRecord.progress);
  const overrideProgress = asObjectRecord(overrideRecord.progress);
  if (baseProgress && overrideProgress) {
    merged.progress = {
      ...baseProgress,
      ...overrideProgress,
    };
  } else if (overrideProgress ?? baseProgress) {
    merged.progress = overrideProgress ?? baseProgress;
  } else {
    delete merged.progress;
  }
  return merged;
}

function mergeStreamingEntry(
  base: AcpParentProgressStreamingConfig,
  override: StreamingCompatEntry | undefined,
): StreamingCompatEntry {
  if (!override) {
    return base;
  }
  return {
    ...base,
    ...override,
    streaming: mergeStreamingConfig(base.streaming, override.streaming),
  };
}

function hasConfiguredPreviewStreamMode(entry: StreamingCompatEntry): boolean {
  return (
    asObjectRecord(entry.streaming)?.mode !== undefined ||
    typeof entry.streaming === "string" ||
    typeof entry.streaming === "boolean"
  );
}

function applyParentPreviewStreamModeDefault(
  entry: StreamingCompatEntry,
  channelId: string,
): StreamingCompatEntry {
  if (channelId !== "discord" || hasConfiguredPreviewStreamMode(entry)) {
    return entry;
  }
  const streaming = asObjectRecord(entry.streaming);
  return {
    ...entry,
    streaming: streaming
      ? {
          ...streaming,
          mode: "progress",
        }
      : {
          mode: "progress",
        },
  };
}

function resolveParentProgressStreamingEntry(params: {
  cfg: OpenClawConfig | undefined;
  deliveryContext: DeliveryContext | undefined;
}): StreamingCompatEntry | undefined {
  const channelId = normalizeOptionalString(params.deliveryContext?.channel);
  if (!params.cfg || !channelId) {
    return undefined;
  }
  const channels = params.cfg.channels as
    | Record<string, AcpParentProgressStreamingConfig | undefined>
    | undefined;
  const channelCfg = channels?.[channelId];
  if (!channelCfg) {
    return undefined;
  }
  const accountCfg = resolveNormalizedAccountEntry(
    channelCfg.accounts,
    normalizeAccountId(params.deliveryContext?.accountId),
    normalizeAccountId,
  );
  return applyParentPreviewStreamModeDefault(
    mergeStreamingEntry(channelCfg, accountCfg),
    channelId,
  );
}

function resolveParentProgressCommentary(params: {
  cfg: OpenClawConfig | undefined;
  deliveryContext: DeliveryContext | undefined;
}): boolean {
  return resolveChannelStreamingProgressCommentary(
    resolveParentProgressStreamingEntry(params),
    true,
  );
}

function shouldRelayAcpStatusProgress(params: {
  eventType: string | undefined;
  tag: string | undefined;
  text: string | undefined;
  projectionSettings: AcpProjectionSettings;
}): boolean {
  if (params.eventType !== "status" || !params.text) {
    return false;
  }
  return isAcpTagVisible(params.projectionSettings, params.tag);
}

/** Starts a bounded parent-session relay for child ACP output and progress notices. */
export function startAcpSpawnParentStreamRelay(params: {
  runId: string;
  parentSessionKey: string;
  childSessionKey: string;
  childSessionId?: string;
  agentId: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Optional `session.mainKey` from the runtime config. Used to remap
   * cron-run parent session keys to the agent's main queue when relaying
   * events. Caller passes the spawn-time `cfg.session?.mainKey`; pass-through
   * of `undefined` falls back to the literal "main" default. Long-running
   * relays keep using that start-time value if config changes while the child
   * session is still streaming.
   */
  mainKey?: string;
  /**
   * Optional `session.scope` from the runtime config. Required so global-scope
   * agents route cron-run events to the "global" queue instead of agent-main.
   * Snapshotted with `mainKey` for the same start-time routing reason.
   */
  sessionScope?: "per-sender" | "global";
  eventRouting?: EventSessionRoutingPolicy;
  deliveryContext?: DeliveryContext;
  surfaceUpdates?: boolean;
  streamFlushMs?: number;
  noOutputNoticeMs?: number;
  noOutputPollMs?: number;
  maxRelayLifetimeMs?: number;
  emitStartNotice?: boolean;
  cfg?: OpenClawConfig;
}): AcpSpawnParentRelayHandle {
  const runId = normalizeOptionalString(params.runId) ?? "";
  const parentSessionKey = normalizeOptionalString(params.parentSessionKey) ?? "";
  if (!runId || !parentSessionKey) {
    return {
      dispose: () => {},
      notifyStarted: () => {},
    };
  }

  const streamFlushMs =
    typeof params.streamFlushMs === "number" && Number.isFinite(params.streamFlushMs)
      ? Math.max(0, Math.floor(params.streamFlushMs))
      : DEFAULT_STREAM_FLUSH_MS;
  const noOutputNoticeMs =
    typeof params.noOutputNoticeMs === "number" && Number.isFinite(params.noOutputNoticeMs)
      ? Math.max(0, Math.floor(params.noOutputNoticeMs))
      : DEFAULT_NO_OUTPUT_NOTICE_MS;
  const noOutputPollMs =
    typeof params.noOutputPollMs === "number" && Number.isFinite(params.noOutputPollMs)
      ? Math.max(250, Math.floor(params.noOutputPollMs))
      : DEFAULT_NO_OUTPUT_POLL_MS;
  const maxRelayLifetimeMs =
    typeof params.maxRelayLifetimeMs === "number" && Number.isFinite(params.maxRelayLifetimeMs)
      ? Math.max(1_000, Math.floor(params.maxRelayLifetimeMs))
      : DEFAULT_MAX_RELAY_LIFETIME_MS;

  const relayLabel = truncate(compactWhitespace(params.agentId), 40) || "ACP child";
  const contextPrefix = `acp-spawn:${runId}`;
  const childSessionId = normalizeOptionalString(params.childSessionId);
  // Delayed flushes must keep the state database selected when the relay started.
  const stateEnv = { ...(params.env ?? process.env) };
  const pendingLogEvents: Array<{ event: AcpParentStreamEvent; createdAt: number }> = [];
  let logFlushTimer: NodeJS.Timeout | undefined;
  let logFailureWarned = false;
  let logBufferWarned = false;
  let consecutiveLogFailures = 0;
  let disposed = false;
  const capPendingLogEvents = () => {
    const overflow = pendingLogEvents.length - STREAM_LOG_MAX_PENDING_EVENTS;
    if (overflow <= 0) {
      return;
    }
    pendingLogEvents.splice(0, overflow);
    if (!logBufferWarned) {
      log.warn("Capped ACP parent stream diagnostic buffer", {
        runId,
        childSessionId,
        maxPendingEvents: STREAM_LOG_MAX_PENDING_EVENTS,
      });
      logBufferWarned = true;
    }
  };
  const clearLogFlushTimer = () => {
    if (!logFlushTimer) {
      return;
    }
    clearTimeout(logFlushTimer);
    logFlushTimer = undefined;
  };
  function flushLogEvents(options: { terminal?: boolean } = {}) {
    clearLogFlushTimer();
    if (!childSessionId || pendingLogEvents.length === 0) {
      return;
    }
    const events = pendingLogEvents.splice(0);
    try {
      recordAcpParentStreamEvents({
        agentId: params.agentId,
        env: stateEnv,
        sessionId: childSessionId,
        runId,
        events,
      });
      logFailureWarned = false;
      logBufferWarned = false;
      consecutiveLogFailures = 0;
    } catch (error) {
      if (!options.terminal) {
        pendingLogEvents.unshift(...events);
        capPendingLogEvents();
        consecutiveLogFailures += 1;
        scheduleLogFlush(
          Math.min(STREAM_LOG_FLUSH_MS * 2 ** consecutiveLogFailures, STREAM_LOG_MAX_RETRY_MS),
        );
      }
      if (!logFailureWarned || options.terminal) {
        log.warn("Failed to persist ACP parent stream diagnostics", {
          runId,
          childSessionId,
          retrying: !options.terminal,
          error: String(error),
        });
        logFailureWarned = true;
      }
    }
  }
  function scheduleLogFlush(delayMs = STREAM_LOG_FLUSH_MS) {
    if (disposed || logFlushTimer || pendingLogEvents.length === 0) {
      return;
    }
    logFlushTimer = setTimeout(() => flushLogEvents(), delayMs);
    logFlushTimer.unref?.();
  }
  const logEvent = (kind: string, fields?: Record<string, unknown>) => {
    if (!childSessionId) {
      return;
    }
    const createdAt = Date.now();
    pendingLogEvents.push({
      createdAt,
      event: {
        ts: new Date(createdAt).toISOString(),
        epochMs: createdAt,
        runId,
        parentSessionKey,
        childSessionKey: params.childSessionKey,
        agentId: params.agentId,
        kind,
        ...fields,
      },
    });
    capPendingLogEvents();
    if (consecutiveLogFailures === 0 && pendingLogEvents.length >= STREAM_LOG_BATCH_SIZE) {
      flushLogEvents();
      return;
    }
    scheduleLogFlush();
  };
  const shouldSurfaceUpdates = params.surfaceUpdates !== false;
  const shouldRelayProgressCommentary = resolveParentProgressCommentary({
    cfg: params.cfg,
    deliveryContext: params.deliveryContext,
  });
  const acpProjectionSettings = resolveAcpProjectionSettings(params.cfg ?? {});
  const eventRouting = params.eventRouting ?? {
    mainKey: params.mainKey,
    sessionScope: params.sessionScope,
  };
  const wake = () => {
    if (!shouldSurfaceUpdates) {
      return;
    }
    requestHeartbeat(
      scopedHeartbeatWakeOptionsForPolicy(
        parentSessionKey,
        {
          source: "acp-spawn",
          intent: "event",
          reason: "acp:spawn:stream",
        },
        eventRouting,
      ),
    );
  };
  const emit = (text: string, contextKey: string) => {
    const cleaned = text.trim();
    if (!cleaned) {
      return;
    }
    logEvent("system_event", { contextKey, text: cleaned });
    if (!shouldSurfaceUpdates) {
      return;
    }
    enqueueSystemEvent(cleaned, {
      sessionKey: resolveEventSessionKeyForPolicy(parentSessionKey, eventRouting),
      contextKey,
      deliveryContext: params.deliveryContext,
    });
    wake();
  };
  const emitStartNotice = () => {
    recordTaskRunProgressByRunId({
      runId,
      runtime: "acp",
      sessionKey: params.childSessionKey,
      lastEventAt: Date.now(),
      eventSummary: "Started.",
    });
    emit(
      `Started ${relayLabel} session ${params.childSessionKey}. Streaming progress updates to parent session.`,
      `${contextPrefix}:start`,
    );
  };

  let pendingText = "";
  let pendingProgressKind: string | undefined;
  let replaceableAssistantSnapshot: string | undefined;
  const itemProgressTextById = new Map<string, string>();
  let lastProgressAt = Date.now();
  let stallNotified = false;
  let promptSubmittedAt: number | undefined;
  let firstRuntimeEventAt: number | undefined;
  let firstVisibleOutputAt: number | undefined;
  let lastRuntimeEventType: string | undefined;
  let proxyEnvKeysAtPrompt: string[] = [];
  let flushTimer: NodeJS.Timeout | undefined;
  let relayLifetimeTimer: NodeJS.Timeout | undefined;

  const clearFlushTimer = () => {
    if (!flushTimer) {
      return;
    }
    clearTimeout(flushTimer);
    flushTimer = undefined;
  };
  const clearRelayLifetimeTimer = () => {
    if (!relayLifetimeTimer) {
      return;
    }
    clearTimeout(relayLifetimeTimer);
    relayLifetimeTimer = undefined;
  };

  const flushPending = () => {
    clearFlushTimer();
    if (!pendingText) {
      return;
    }
    const snippet = truncate(compactWhitespace(pendingText), STREAM_SNIPPET_MAX_CHARS);
    pendingText = "";
    pendingProgressKind = undefined;
    if (!snippet) {
      return;
    }
    emit(`${relayLabel}: ${snippet}`, `${contextPrefix}:progress`);
  };

  const scheduleFlush = () => {
    if (disposed || flushTimer || streamFlushMs <= 0) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushPending();
    }, streamFlushMs);
    flushTimer.unref?.();
  };

  const appendVisibleProgress = (delta: string, kind: string) => {
    if (stallNotified) {
      stallNotified = false;
      recordTaskRunProgressByRunId({
        runId,
        runtime: "acp",
        sessionKey: params.childSessionKey,
        lastEventAt: Date.now(),
        eventSummary: "Resumed output.",
      });
      emit(`${relayLabel} resumed output.`, `${contextPrefix}:resumed`);
    }

    lastProgressAt = Date.now();
    firstVisibleOutputAt ??= lastProgressAt;
    if (pendingText && pendingProgressKind && pendingProgressKind !== kind) {
      flushPending();
    }
    pendingProgressKind = kind;
    pendingText += delta;
    if (pendingText.length > STREAM_BUFFER_MAX_CHARS) {
      pendingText = sliceUtf16Safe(pendingText, -STREAM_BUFFER_MAX_CHARS);
    }
    if (pendingText.length >= STREAM_SNIPPET_MAX_CHARS || delta.includes("\n\n")) {
      flushPending();
      return;
    }
    scheduleFlush();
  };

  const flushReplaceableAssistantSnapshot = () => {
    const snapshot = replaceableAssistantSnapshot;
    replaceableAssistantSnapshot = undefined;
    if (!snapshot?.trim()) {
      return;
    }
    appendVisibleProgress(snapshot, "assistant:replaceable");
  };

  const appendItemProgressSnapshot = (snapshot: { itemId: string; text: string }) => {
    const previous = itemProgressTextById.get(snapshot.itemId) ?? "";
    if (snapshot.text === previous) {
      return;
    }
    const kind = `item:${snapshot.itemId}`;
    const isPrefixUpdate = Boolean(previous && snapshot.text.startsWith(previous));
    const hasPendingSnapshot = pendingProgressKind === kind && Boolean(pendingText);
    if (previous && !isPrefixUpdate && hasPendingSnapshot) {
      pendingText = "";
    }
    itemProgressTextById.set(snapshot.itemId, snapshot.text);
    const delta = isPrefixUpdate ? snapshot.text.slice(previous.length) : snapshot.text;
    appendVisibleProgress(delta, kind);
  };

  const buildNoOutputNotice = () => {
    const seconds = Math.round(noOutputNoticeMs / 1000);
    if (!promptSubmittedAt) {
      return {
        summary: `No prompt submission observed for ${seconds}s after child start.`,
        text: `${relayLabel} session started but no prompt submission was observed for ${seconds}s.`,
      };
    }
    if (!firstRuntimeEventAt) {
      const proxySummary = formatProxyEnvSummary(proxyEnvKeysAtPrompt);
      return {
        summary: `Prompt submitted but no ACP runtime event for ${seconds}s (${proxySummary}).`,
        text: `${relayLabel} prompt was submitted but no ACP runtime event arrived for ${seconds}s (${proxySummary}). Check upstream connectivity, auth, or proxy/network access in the gateway child environment.`,
      };
    }
    if (!firstVisibleOutputAt) {
      const lastEvent = lastRuntimeEventType ? ` Last ACP event: ${lastRuntimeEventType}.` : "";
      return {
        summary: `ACP runtime active but no visible assistant output for ${seconds}s.${lastEvent}`,
        text: `${relayLabel} has ACP runtime activity but no visible assistant output for ${seconds}s.${lastEvent} It may be working, blocked on a tool, or failing before visible output.`,
      };
    }
    return {
      summary: `No visible output for ${seconds}s. It may be waiting for input.`,
      text: `${relayLabel} has produced no visible output for ${seconds}s. It may be waiting for interactive input.`,
    };
  };

  const noOutputWatcherTimer = setInterval(() => {
    if (disposed || noOutputNoticeMs <= 0) {
      return;
    }
    if (stallNotified) {
      return;
    }
    if (Date.now() - lastProgressAt < noOutputNoticeMs) {
      return;
    }
    stallNotified = true;
    const notice = buildNoOutputNotice();
    recordTaskRunProgressByRunId({
      runId,
      runtime: "acp",
      sessionKey: params.childSessionKey,
      lastEventAt: Date.now(),
      eventSummary: notice.summary,
    });
    emit(notice.text, `${contextPrefix}:stall`);
  }, noOutputPollMs);
  noOutputWatcherTimer.unref?.();

  relayLifetimeTimer = setTimeout(() => {
    if (disposed) {
      return;
    }
    emit(
      `${relayLabel} stream relay timed out after ${Math.max(1, Math.round(maxRelayLifetimeMs / 1000))}s without completion.`,
      `${contextPrefix}:timeout`,
    );
    dispose();
  }, maxRelayLifetimeMs);
  relayLifetimeTimer.unref?.();

  if (params.emitStartNotice !== false) {
    emitStartNotice();
  }

  const unsubscribe = onAgentEvent((event) => {
    if (disposed || event.runId !== runId) {
      return;
    }

    if (event.stream === "assistant") {
      const data = event.data;
      const assistantPhase = normalizeAssistantPhase(
        (data as { phase?: unknown } | undefined)?.phase,
      );
      const textCandidate = (data as { text?: unknown } | undefined)?.text;
      const deltaCandidate = (data as { delta?: unknown } | undefined)?.delta;
      const snapshot =
        typeof textCandidate === "string"
          ? textCandidate
          : typeof deltaCandidate === "string"
            ? deltaCandidate
            : undefined;
      if ((data as { replaceable?: unknown } | undefined)?.replaceable === true) {
        if (snapshot?.trim()) {
          replaceableAssistantSnapshot = snapshot;
          lastProgressAt = Date.now();
          logEvent("assistant_replaceable_snapshot", {
            text: snapshot,
            ...(assistantPhase ? { phase: assistantPhase } : {}),
          });
        }
        return;
      }

      const delta = typeof deltaCandidate === "string" ? deltaCandidate : snapshot;
      if (!delta || !delta.trim()) {
        return;
      }
      logEvent("assistant_delta", {
        delta,
        ...(assistantPhase ? { phase: assistantPhase } : {}),
      });

      if (assistantPhase === "commentary" && !shouldRelayProgressCommentary) {
        lastProgressAt = Date.now();
        return;
      }

      replaceableAssistantSnapshot = undefined;
      appendVisibleProgress(delta, `assistant:${assistantPhase ?? "unknown"}`);
      return;
    }

    if (event.stream === "item") {
      const data = event.data as
        | {
            itemId?: unknown;
            kind?: unknown;
            progressText?: unknown;
          }
        | undefined;
      const itemId = normalizeOptionalString(data?.itemId);
      const kind = normalizeOptionalString(data?.kind);
      const progressText = normalizeOptionalString(data?.progressText);
      if (kind === "preamble" && progressText) {
        lastProgressAt = Date.now();
        if (shouldRelayProgressCommentary && itemId) {
          appendItemProgressSnapshot({ itemId, text: progressText });
        }
      }
      return;
    }

    if (event.stream === "acp") {
      const data = event.data as
        | {
            phase?: unknown;
            at?: unknown;
            eventType?: unknown;
            tag?: unknown;
            text?: unknown;
            proxyEnvKeys?: unknown;
          }
        | undefined;
      const phase = normalizeOptionalString(data?.phase);
      logEvent("acp", { phase: phase ?? "unknown", data: event.data });
      if (phase === "prompt_submitted") {
        const at = asFiniteNumber(data?.at) ?? Date.now();
        promptSubmittedAt ??= at;
        proxyEnvKeysAtPrompt = normalizeStringArray(data?.proxyEnvKeys);
        lastProgressAt = Date.now();
        return;
      }
      if (phase === "runtime_event") {
        const eventType = normalizeOptionalString(data?.eventType);
        const text = normalizeOptionalString(data?.text);
        const tag = normalizeOptionalString(data?.tag);
        firstRuntimeEventAt ??= Date.now();
        lastRuntimeEventType = eventType;
        if (
          shouldRelayProgressCommentary &&
          shouldRelayAcpStatusProgress({
            eventType,
            tag,
            text,
            projectionSettings: acpProjectionSettings,
          })
        ) {
          appendVisibleProgress(`${text}\n\n`, "acp:status");
          return;
        }
        lastProgressAt = Date.now();
        return;
      }
      return;
    }

    if (event.stream !== "lifecycle") {
      return;
    }

    const phase = normalizeOptionalString((event.data as { phase?: unknown } | undefined)?.phase);
    logEvent("lifecycle", { phase: phase ?? "unknown", data: event.data });
    if (phase === "end") {
      flushReplaceableAssistantSnapshot();
      flushPending();
      const startedAt = asFiniteNumber(
        (event.data as { startedAt?: unknown } | undefined)?.startedAt,
      );
      const endedAt = asFiniteNumber((event.data as { endedAt?: unknown } | undefined)?.endedAt);
      const durationMs =
        startedAt != null && endedAt != null && endedAt >= startedAt
          ? endedAt - startedAt
          : undefined;
      if (durationMs != null) {
        emit(
          `${relayLabel} run completed in ${Math.max(1, Math.round(durationMs / 1000))}s.`,
          `${contextPrefix}:done`,
        );
      } else {
        emit(`${relayLabel} run completed.`, `${contextPrefix}:done`);
      }
      dispose();
      return;
    }

    if (phase === "error") {
      flushReplaceableAssistantSnapshot();
      flushPending();
      const errorText = normalizeOptionalString(
        (event.data as { error?: unknown } | undefined)?.error,
      );
      if (errorText) {
        emit(`${relayLabel} run failed: ${errorText}`, `${contextPrefix}:error`);
      } else {
        emit(`${relayLabel} run failed.`, `${contextPrefix}:error`);
      }
      dispose();
    }
  });

  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    clearFlushTimer();
    flushLogEvents({ terminal: true });
    clearRelayLifetimeTimer();
    clearInterval(noOutputWatcherTimer);
    unsubscribe();
  };

  return {
    dispose,
    notifyStarted: emitStartNotice,
  };
}

export type AcpSpawnParentRelayHandle = {
  dispose: () => void;
  notifyStarted: () => void;
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
