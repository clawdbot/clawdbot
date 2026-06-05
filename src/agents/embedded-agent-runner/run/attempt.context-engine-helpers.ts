/**
 * Bridges attempt bootstrap/history data to context-engine prompt-cache helpers.
 */
import type { ContextEngine } from "../../../context-engine/types.js";
import type { AssistantMessage } from "../../../llm/types.js";
import type { BootstrapMode } from "../../bootstrap-mode.js";
import type { AgentMessage } from "../../runtime/index.js";
import { normalizeUsage, type NormalizedUsage } from "../../usage.js";
import type { PromptCacheChange } from "../prompt-cache-observability.js";
import type { EmbeddedRunAttemptResult } from "./types.js";
export {
  assembleHarnessContextEngine as assembleAttemptContextEngine,
  bootstrapHarnessContextEngine as runAttemptContextEngineBootstrap,
  finalizeHarnessContextEngineTurn as finalizeAttemptContextEngineTurn,
} from "../../harness/context-engine-lifecycle.js";

export type AttemptContextEngine = ContextEngine;

export type AttemptBootstrapContext<TBootstrapFile = unknown, TContextFile = unknown> = {
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
  bootstrapContextRunKind?: string;
  bootstrapMode?: BootstrapMode;
  sessionFile: string;
  hasCompletedBootstrapTurn: (sessionFile: string) => Promise<boolean>;
  resolveBootstrapContextForRun: () => Promise<
    AttemptBootstrapContext<TBootstrapFile, TContextFile>
  >;
}): Promise<
  AttemptBootstrapContext<TBootstrapFile, TContextFile> & {
    isContinuationTurn: boolean;
    shouldRecordCompletedBootstrapTurn: boolean;
  }
> {
  const isContinuationTurn =
    params.bootstrapMode !== "full" &&
    params.contextInjectionMode === "continuation-skip" &&
    params.bootstrapContextRunKind !== "heartbeat" &&
    (await params.hasCompletedBootstrapTurn(params.sessionFile));
  // Continuation-skip and explicit never both produce an empty injection set,
  // but only a clean full bootstrap later records a durable completion marker.
  const shouldSkipBootstrapInjection =
    params.contextInjectionMode === "never" || isContinuationTurn;
  const shouldRecordCompletedBootstrapTurn =
    !shouldSkipBootstrapInjection &&
    params.bootstrapContextMode !== "lightweight" &&
    params.bootstrapContextRunKind !== "heartbeat" &&
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
  return params.messagesSnapshot
    .slice(Math.max(0, params.prePromptMessageCount))
    .toReversed()
    .find((message): message is AssistantMessage => message.role === "assistant");
}

function parsePromptCacheTouchTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
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
  const currentAttemptAssistant = findCurrentAttemptAssistantMessage({
    messagesSnapshot: params.messagesSnapshot,
    prePromptMessageCount: params.prePromptMessageCount,
  });
  // Normalize only the assistant produced by this attempt so older transcript
  // usage does not masquerade as a fresh cache touch.
  const lastCallUsage = normalizeUsage(currentAttemptAssistant?.usage);

  return buildContextEnginePromptCacheInfo({
    retention: params.retention,
    lastCallUsage,
    lastCacheTouchAt: resolvePromptCacheTouchTimestamp({
      lastCallUsage,
      assistantTimestamp: currentAttemptAssistant?.timestamp,
      fallbackLastCacheTouchAt: params.fallbackLastCacheTouchAt,
    }),
  });
}
