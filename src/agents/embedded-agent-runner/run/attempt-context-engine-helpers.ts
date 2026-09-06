import { parseDateFirstTimestampMs } from "@openclaw/normalization-core/number-coercion";
/**
 * Bridges attempt bootstrap/history data to context-engine prompt-cache helpers.
 */
import type { ContextEngine } from "../../../context-engine/types.js";
import type { AssistantMessage } from "../../../llm/types.js";
import {
  isHeartbeatLifecycleRunKind,
  type BootstrapContextRunKind,
  type BootstrapMode,
} from "../../bootstrap-mode.js";
import type { AgentMessage } from "../../runtime/index.js";
import { hasNonzeroUsage, normalizeUsage, type NormalizedUsage } from "../../usage.js";
import type { PromptCacheChange } from "../prompt-cache-observability.js";
import type { EmbeddedRunAttemptResult } from "./types.js";
export type AttemptContextEngine = ContextEngine;

type AttemptBootstrapContext<TBootstrapFile = unknown, TContextFile = unknown> = {
  bootstrapFiles: TBootstrapFile[];
  contextFiles: TContextFile[];
};

/**
 * Resolves bootstrap/context files for this attempt and reports whether the
 * caller should persist a completed bootstrap marker. Continuation-skip mode
 * intentionally suppresses reinjection after a full bootstrap turn has already
 * been recorded for the session.
 */
export async function resolveAttemptBootstrapContext<TBootstrapFile, TContextFile>(params: {
  contextInjectionMode: "always" | "continuation-skip" | "never";
  bootstrapContextMode?: string;
  bootstrapContextRunKind?: BootstrapContextRunKind;
  bootstrapMode?: BootstrapMode;
  hasCompletedBootstrapTurn: () => Promise<boolean>;
  resolveBootstrapContextForRun: () => Promise<
    AttemptBootstrapContext<TBootstrapFile, TContextFile>
  >;
}): Promise<
  AttemptBootstrapContext<TBootstrapFile, TContextFile> & {
    isContinuationTurn: boolean;
    shouldRecordCompletedBootstrapTurn: boolean;
  }
> {
  const isHeartbeatLifecycleRun = isHeartbeatLifecycleRunKind(params.bootstrapContextRunKind);
  const isContinuationTurn =
    params.bootstrapMode !== "full" &&
    params.contextInjectionMode === "continuation-skip" &&
    !isHeartbeatLifecycleRun &&
    (await params.hasCompletedBootstrapTurn());
  // Continuation-skip and explicit never both produce an empty injection set,
  // but only a clean full bootstrap later records a durable completion marker.
  const shouldSkipBootstrapInjection =
    params.contextInjectionMode === "never" || isContinuationTurn;
  const shouldRecordCompletedBootstrapTurn =
    !shouldSkipBootstrapInjection &&
    params.bootstrapContextMode !== "lightweight" &&
    !isHeartbeatLifecycleRun &&
    params.bootstrapMode === "full";

  const context = shouldSkipBootstrapInjection
    ? { bootstrapFiles: [], contextFiles: [] }
    : await params.resolveBootstrapContextForRun();

  return {
    ...context,
    isContinuationTurn,
    shouldRecordCompletedBootstrapTurn,
  };
}

/**
 * Builds the compact prompt-cache metadata stored on an attempt result. Empty
 * inputs return undefined so callers do not serialize meaningless cache fields.
 */
export function buildContextEnginePromptCacheInfo(params: {
  retention?: "none" | "short" | "long";
  lastCallUsage?: NormalizedUsage;
  observation?:
    | {
        broke: boolean;
        previousCacheRead?: number;
        cacheRead?: number;
        changes?: PromptCacheChange[] | null;
      }
    | undefined;
  lastCacheTouchAt?: number | null;
}): EmbeddedRunAttemptResult["promptCache"] {
  const promptCache: NonNullable<EmbeddedRunAttemptResult["promptCache"]> = {};
  if (params.retention) {
    promptCache.retention = params.retention;
  }
  if (params.lastCallUsage) {
    promptCache.lastCallUsage = { ...params.lastCallUsage };
  }
  if (params.observation) {
    // Copy only the stable, serializable observation fields into attempt
    // results; runtime-only diagnostic objects stay out of persisted metadata.
    promptCache.observation = {
      broke: params.observation.broke,
      ...(typeof params.observation.previousCacheRead === "number"
        ? { previousCacheRead: params.observation.previousCacheRead }
        : {}),
      ...(typeof params.observation.cacheRead === "number"
        ? { cacheRead: params.observation.cacheRead }
        : {}),
      ...(params.observation.changes && params.observation.changes.length > 0
        ? {
            changes: params.observation.changes.map((change) => ({
              code: change.code,
              detail: change.detail,
            })),
          }
        : {}),
    };
  }
  if (typeof params.lastCacheTouchAt === "number" && Number.isFinite(params.lastCacheTouchAt)) {
    promptCache.lastCacheTouchAt = params.lastCacheTouchAt;
  }
  return Object.keys(promptCache).length > 0 ? promptCache : undefined;
}

/**
 * Finds the assistant message produced by the current attempt, ignoring
 * historical messages that were present before prompt submission.
 */
export function findCurrentAttemptAssistantMessage(params: {
  messagesSnapshot: AgentMessage[];
  prePromptMessageCount: number;
}): AssistantMessage | undefined {
  const firstAttemptIndex = Math.max(0, params.prePromptMessageCount);
  for (let i = params.messagesSnapshot.length - 1; i >= firstAttemptIndex; i--) {
    const message = params.messagesSnapshot[i];
    if (message?.role === "assistant") {
      return message;
    }
  }
  return undefined;
}

/** Finds the newest usable per-call usage without letting a zero-usage abort erase it. */
function findLatestCurrentAttemptUsageSnapshot(params: {
  messagesSnapshot: AgentMessage[];
  prePromptMessageCount: number;
}): { assistant: AssistantMessage; usage: NormalizedUsage } | undefined {
  const firstAttemptIndex = Math.max(0, params.prePromptMessageCount);
  for (let i = params.messagesSnapshot.length - 1; i >= firstAttemptIndex; i--) {
    const message = params.messagesSnapshot[i];
    if (message?.role !== "assistant") {
      continue;
    }
    const usage = normalizeUsage(message.usage);
    if (hasNonzeroUsage(usage)) {
      return { assistant: message, usage };
    }
  }
  return undefined;
}

/** Prevents transcript fallback from crossing a compaction-owned context boundary. */
export function findLatestUncompactedAttemptUsageSnapshot(params: {
  messagesSnapshot: AgentMessage[];
  prePromptMessageCount: number;
  compactionOccurred: boolean;
}): { assistant: AssistantMessage; usage: NormalizedUsage } | undefined {
  if (params.compactionOccurred) {
    return undefined;
  }
  return findLatestCurrentAttemptUsageSnapshot(params);
}

function parsePromptCacheTouchTimestamp(value: unknown): number | null {
  return parseDateFirstTimestampMs(value) ?? null;
}

/**
 * Resolves the effective prompt-cache touch timestamp for the current assistant
 * turn. Cache-read/write usage is required before an assistant timestamp can
 * advance the touch time; otherwise the previous touch is carried forward.
 */
export function resolvePromptCacheTouchTimestamp(params: {
  lastCallUsage?: NormalizedUsage;
  assistantTimestamp?: unknown;
  fallbackLastCacheTouchAt?: number | null;
}): number | null {
  const hasCacheUsage =
    typeof params.lastCallUsage?.cacheRead === "number" ||
    typeof params.lastCallUsage?.cacheWrite === "number";
  if (!hasCacheUsage) {
    return params.fallbackLastCacheTouchAt ?? null;
  }
  return (
    parsePromptCacheTouchTimestamp(params.assistantTimestamp) ??
    params.fallbackLastCacheTouchAt ??
    null
  );
}

/**
 * Derives prompt-cache metadata from the loop transcript snapshot after a model
 * attempt finishes. It combines the current attempt assistant usage with the
 * carried-forward touch timestamp from earlier attempts.
 */
export function buildLoopPromptCacheInfo(params: {
  messagesSnapshot: AgentMessage[];
  prePromptMessageCount: number;
  retention?: "none" | "short" | "long";
  fallbackLastCacheTouchAt?: number | null;
}): EmbeddedRunAttemptResult["promptCache"] {
  const latestUsageSnapshot = findLatestCurrentAttemptUsageSnapshot({
    messagesSnapshot: params.messagesSnapshot,
    prePromptMessageCount: params.prePromptMessageCount,
  });
  const lastCallUsage = latestUsageSnapshot?.usage;

  return buildContextEnginePromptCacheInfo({
    retention: params.retention,
    lastCallUsage,
    lastCacheTouchAt: resolvePromptCacheTouchTimestamp({
      lastCallUsage,
      assistantTimestamp: latestUsageSnapshot?.assistant.timestamp,
      fallbackLastCacheTouchAt: params.fallbackLastCacheTouchAt,
    }),
  });
}
