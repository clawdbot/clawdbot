/** Agent-runner execution loop, fallback handling, and user-facing failure mapping. */
import crypto from "node:crypto";
import fs from "node:fs";
import {
  hasNonEmptyString,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import {
  clearAutoFallbackPrimaryProbeSelection,
  entryMatchesAutoFallbackPrimaryProbe,
  hasSessionAutoModelFallbackProvenance,
  markAutoFallbackPrimaryProbe,
  resolveAutoFallbackPrimaryProbe,
} from "../../agents/agent-scope.js";
import { formatAuthProfileFailureMessage } from "../../agents/auth-profiles/failure-copy.js";
import {
  buildOAuthRefreshFailureLoginCommand,
  classifyOAuthRefreshFailure,
  classifyOAuthRefreshFailureError,
  formatOAuthRefreshFailureLoginCommandMarkdown,
} from "../../agents/auth-profiles/oauth-refresh-failure.js";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import type { BootstrapContextRunKind } from "../../agents/bootstrap-mode.js";
import { getCliSessionBinding } from "../../agents/cli-session.js";
import { resolveContextTokensForModel } from "../../agents/context.js";
import {
  BILLING_ERROR_USER_MESSAGE,
  formatBillingErrorMessage,
  formatRateLimitOrOverloadedErrorCopy,
  isCompactionFailureError,
  isContextOverflowError,
  isBillingErrorMessage,
  isLikelyContextOverflowError,
  isOverloadedErrorMessage,
  isRateLimitErrorMessage,
  isTransientHttpError,
} from "../../agents/embedded-agent-helpers.js";
import { isPeriodicUsageLimitErrorMessage } from "../../agents/embedded-agent-helpers/failover-matches.js";
import { sanitizeUserFacingText } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import { isMessagingToolSendAction } from "../../agents/embedded-agent-messaging.js";
import { mergeEmbeddedAgentRunResultForModelFallbackExhaustion } from "../../agents/embedded-agent-runner/result-fallback-classifier.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { EmbeddedAgentCompactResult } from "../../agents/embedded-agent-runner/types.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { isFailoverError } from "../../agents/failover-error.js";
import type { FastModeAutoProgressState } from "../../agents/fast-mode.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import { ensureSelectedAgentHarnessPlugin } from "../../agents/harness/runtime-plugin.js";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import { isMissingProviderAuthError } from "../../agents/model-auth.js";
import { runWithModelFallback, isFallbackSummaryError } from "../../agents/model-fallback.js";
import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import {
  isCliProvider,
  resolveModelRefFromString,
  resolvePersistedOverrideModelRef,
} from "../../agents/model-selection.js";
import { resolveOpenAIRuntimeProvider } from "../../agents/openai-routing.js";
import {
  AGENT_RUN_RESTART_ABORT_STOP_REASON,
  createAgentRunRestartAbortError,
  isAgentRunRestartAbortReason,
  resolveAgentRunErrorLifecycleFields,
} from "../../agents/run-termination.js";
import { buildAgentRuntimeOutcomePlan } from "../../agents/runtime-plan/build.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import { resolveCandidateThinkingLevel } from "../../agents/thinking-runtime.js";
import type { ContinueWorkRequest } from "../../agents/tools/continue-work-tool.js";
import {
  resolveFreshSessionTotalTokens,
  resolveGroupSessionKey,
  resolveSessionStoreEntry,
  resolveSessionTranscriptPath,
  type SessionEntry,
  type SessionPostCompactionDelegate,
} from "../../config/sessions.js";
import { removeSessionEntry, updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { resolveSilentReplyPolicy } from "../../config/silent-reply.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  isTrustedMessageActionTurnIngress,
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { logVerbose } from "../../globals.js";
import {
  captureAgentRunLifecycleGeneration,
  clearAgentRunContext,
  emitAgentEvent,
  registerAgentRunContext,
} from "../../infra/agent-events.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveHeartbeatRunScope } from "../../infra/heartbeat-run-scope.js";
import { logSessionTurnCreated } from "../../logging/diagnostic.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CommandLaneClearedError, GatewayDrainingError } from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { defaultRuntime } from "../../runtime.js";
import { shouldPreserveUserFacingSessionStateForInputProvenance } from "../../sessions/input-provenance.js";
import {
  isMarkdownCapableMessageChannel,
  isInternalMessageChannel,
  resolveMessageChannel,
} from "../../utils/message-channel.js";
import { stagePostCompactionDelegate } from "../continuation-delegate-store.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import {
  HEARTBEAT_TOKEN,
  isSilentReplyPrefixText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripContinuationSignal,
  stripLeadingSilentToken,
} from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  createAgentLifecycleTerminalBackstop,
  resolveAgentLifecycleTerminalMetadata,
  type AgentLifecycleTerminalBackstop,
} from "./agent-lifecycle-terminal.js";
import { resolveRunAuthProfile } from "./agent-runner-auth-profile.js";
import {
  clearDroppedCliSessionBinding,
  createCliReasoningStreamBridge,
  createCliToolSummaryTracker,
  keepCliSessionBindingOnlyWhenReused,
  runCliAgentWithLifecycle,
} from "./agent-runner-cli-dispatch.js";
import {
  GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
  HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
} from "./agent-runner-failure-copy.js";
import {
  buildEmbeddedRunExecutionParams,
  resolveQueuedReplyRuntimeConfig,
  resolveModelFallbackOptions,
  resolveRunFastModeForFallbackCandidate,
} from "./agent-runner-utils.js";
import type { BlockReplyPipeline } from "./block-reply-pipeline.js";
import {
  createCompactionHookNoticePayload,
  createCompactionNoticePayload,
  readCompactionHookMessages,
  shouldNotifyUserAboutCompaction,
} from "./compaction-notice.js";
import { resolveCurrentTurnImages } from "./current-turn-images.js";
import { hasInboundAudio } from "./inbound-media.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { drainPendingToolTasks } from "./pending-tool-task-drain.js";
import {
  classifyProviderRequestError,
  PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE,
} from "./provider-request-error-classifier.js";
import type { FollowupRun } from "./queue.js";
import { createBlockReplyDeliveryHandler } from "./reply-delivery.js";
import type { ReplyMediaContext } from "./reply-media-paths.js";
import { createReplyMediaContext } from "./reply-media-paths.runtime.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { isReplyProfilerEnabled } from "./reply-timing-tracker.js";
import { resolveReplyHookTrigger, resolveReplyRunFireReason } from "./run-provenance.js";
import type { TypingSignaler } from "./typing-mode.js";

type EmbeddedAgentRunResult = Awaited<ReturnType<typeof runEmbeddedAgent>>;

/** Type guard for wrapped continuation run results. */
function isContinuationWrappedRunResult(result: unknown): result is {
  result: EmbeddedAgentRunResult;
  continueWorkRequests?: ContinueWorkRequest[];
  compactionTraceparent?: string;
} {
  return (
    typeof result === "object" &&
    result !== null &&
    "result" in result &&
    "continueWorkRequests" in result
  );
}

// Maximum number of LiveSessionModelSwitchError retries before surfacing a
// user-visible error. Prevents infinite ping-pong when the persisted session
// selection keeps conflicting with fallback model choices.
// See: https://github.com/openclaw/openclaw/issues/58348
export const MAX_LIVE_SWITCH_RETRIES = 2;
const BLOCKED_LIVENESS_NOTICE_TEXT =
  "⚠️ Agent liveness: blocked. The run cannot make progress; try again or start a fresh conversation if this repeats.";

export async function releaseQueuedCompactionCompletion(params: {
  activeSessionStore?: Record<string, SessionEntry>;
  compactionResult: EmbeddedAgentCompactResult;
  followupRun: FollowupRun;
  getActiveSessionEntry: () => SessionEntry | undefined;
  sessionKey?: string;
  storePath?: string;
  traceparent?: string;
}): Promise<void> {
  if (!params.compactionResult.ok || !params.compactionResult.compacted) {
    return;
  }
  if (!params.sessionKey || !params.activeSessionStore) {
    logVerbose(
      `[request_compaction:post-compaction-release-skipped] session=${params.sessionKey ?? "none"} reason=session-store-unavailable`,
    );
    return;
  }

  const sessionEntry =
    params.getActiveSessionEntry() ?? params.activeSessionStore[params.sessionKey];
  if (!sessionEntry) {
    logVerbose(
      `[request_compaction:post-compaction-release-skipped] session=${params.sessionKey} reason=session-entry-unavailable`,
    );
    return;
  }

  const { incrementRunCompactionCount } = await import("./session-run-accounting.js");
  const compactionId = await incrementRunCompactionCount({
    cfg: params.followupRun.run.config,
    sessionEntry,
    sessionStore: params.activeSessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    amount: 1,
    compactionTokensAfter: params.compactionResult.result?.tokensAfter,
    newSessionId: params.compactionResult.result?.sessionId,
    newSessionFile: params.compactionResult.result?.sessionFile,
  });

  const resolved = resolveSessionStoreEntry({
    store: params.activeSessionStore,
    sessionKey: params.sessionKey,
  });
  const refreshedSessionEntry = resolved.existing ?? sessionEntry;
  await releasePostCompactionDelegatesAfterCompaction({
    activeSessionStore: params.activeSessionStore,
    compactionCount: compactionId,
    followupRun: params.followupRun,
    sessionEntry: refreshedSessionEntry,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    traceparent: params.traceparent,
  });
}

export async function releasePostCompactionDelegatesAfterCompaction(params: {
  activeSessionStore: Record<string, SessionEntry>;
  compactionCount: number | undefined;
  followupRun: FollowupRun;
  sessionEntry: SessionEntry;
  sessionKey: string;
  storePath?: string;
  traceparent?: string;
}): Promise<void> {
  const { dispatchPostCompactionDelegates } =
    await import("./post-compaction-delegate-dispatch.js");
  // Shared by volitional and Gateway manual compaction: the transcript has
  // already rotated, so staged post-compaction delegates must be released now
  // without re-running session accounting.
  // dispatchPostCompactionDelegates pushes delegates that failed both the
  // delivery enqueue and the internal re-persist onto this array. Re-stage the
  // survivors below so a double persistence failure does not silently drop
  // compaction recovery work.
  const postCompactionDelegatesToPreserve: SessionPostCompactionDelegate[] = [];
  const dispatchResult = await dispatchPostCompactionDelegates({
    cfg: params.followupRun.run.config,
    compactionCount: params.compactionCount,
    followupRun: params.followupRun,
    postCompactionDelegatesToPreserve,
    releaseTraceparent: params.traceparent,
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
    sessionStore: params.activeSessionStore,
    storePath: params.storePath,
  });

  for (const delegate of postCompactionDelegatesToPreserve) {
    stagePostCompactionDelegate(params.sessionKey, delegate);
  }

  const { emitContinuationCompactionReleasedSpan } =
    await import("../../infra/continuation-tracer.js");
  emitContinuationCompactionReleasedSpan({
    releasedCount: dispatchResult.queuedDelegates,
    compactionId: params.compactionCount,
    traceparent: params.traceparent,
    log: (message) => logVerbose(message),
  });
}

// Wraps releaseQueuedCompactionCompletion so post-compaction cleanup
// errors (count-write / delegate dispatch / tracer emit) never flip the
// caller's compaction-outcome signal. compactEmbeddedAgentSession has
// already mutated session-snapshot truth on disk before we get here; if
// release throws and the caller sees `{ ok: false, compacted: false }`,
// the agent retries compaction on an already-compacted session (#816).
export async function releaseQueuedCompactionTolerant(
  params: Parameters<typeof releaseQueuedCompactionCompletion>[0],
): Promise<void> {
  try {
    await releaseQueuedCompactionCompletion(params);
  } catch (releaseErr) {
    const reason = releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
    logVerbose(
      `[request_compaction:post-compaction-release-failed] session=${params.sessionKey ?? "none"} reason=${reason}`,
    );
  }
}

// Computes the context-usage ratio supplied to request-compaction-tool's
// MIN_CONTEXT_THRESHOLD gate (request-compaction-tool.ts:208-228). Returns
// null in two cases that both map to the consumer's [request_compaction:
// context-unknown] rejection path (request-compaction-tool.ts:209):
//   - totalTokens is missing, invalid, or known-stale (totalTokensFresh=false)
//   - the context-window denominator cannot be resolved for this provider/model
// Returning null is preferable to a synthetic ratio because the consumer
// already distinguishes "unknown" from "below-threshold" with separate
// rejection codes and operator-facing reasons (#817).
export function computeRequestCompactionContextUsage(params: {
  entry: SessionEntry | undefined;
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
}): number | null {
  // Honor the canonical freshness contract: when the prior turn could not
  // compute a fresh totalTokens snapshot (set in session-store.ts:253,280),
  // the value is explicitly known-stale and consumers must refuse to use it
  // for context-utilization gates. Matches the pattern in status-message.ts:
  // 689-694 and sessions.ts:430-431 (#817).
  const freshTotalTokens = resolveFreshSessionTotalTokens(params.entry);
  if (freshTotalTokens === undefined) {
    return null;
  }
  // Resolve the context-window denominator via the canonical pipeline
  // (session-entry → cfg/provider/model lookup) instead of a hardcoded 200K
  // fallback. The 200K hardcode misreports utilization on 100K context
  // models (under-fire) and 1M context models (over-fire). No other
  // production caller in the codebase uses a ?? 200_000 shortcut here;
  // they all route through resolveContextTokensForModel /
  // resolveContextWindowInfo (#817).
  const sessionWindow = params.entry?.contextTokens;
  const contextWindow =
    sessionWindow ??
    resolveContextTokensForModel({
      cfg: params.cfg,
      provider: params.provider,
      model: params.model,
      allowAsyncLoad: false,
    });
  if (typeof contextWindow !== "number" || contextWindow <= 0) {
    return null;
  }
  return freshTotalTokens / contextWindow;
}

type AgentTurnTimingSpan = {
  name: string;
  durationMs: number;
  elapsedMs: number;
};

type AgentTurnTimingSummary = {
  totalMs: number;
  spans: AgentTurnTimingSpan[];
};

const agentTurnTimingLog = createSubsystemLogger("auto-reply/agent-turn-timing");
const agentCompactionLog = createSubsystemLogger("auto-reply/compaction");
const CODEX_APP_SERVER_COMPACTION_BACKEND = "codex-app-server";
const AGENT_TURN_TIMING_WARN_TOTAL_MS = 1_000;
const AGENT_TURN_TIMING_WARN_STAGE_MS = 500;

function formatCompactionModelRef(provider?: string, model?: string): string {
  const normalizedProvider = normalizeOptionalString(provider);
  const normalizedModel = normalizeOptionalString(model);
  if (normalizedProvider && normalizedModel) {
    return `${sanitizeForLog(normalizedProvider)}/${sanitizeForLog(normalizedModel)}`;
  }
  if (normalizedProvider) {
    return sanitizeForLog(normalizedProvider);
  }
  if (normalizedModel) {
    return sanitizeForLog(normalizedModel);
  }
  return "unknown model";
}

function createAgentTurnTimingTracker(options: { profilerEnabled?: boolean } = {}): {
  measure: <T>(name: string, run: () => Promise<T> | T) => Promise<T>;
  measureSync: <T>(name: string, run: () => T) => T;
  logIfSlow: (params: {
    runId: string;
    sessionId?: string;
    sessionKey?: string;
    outcome: "completed" | "error";
    error?: string;
  }) => void;
  logMilestoneIfSlow: (params: {
    runId: string;
    sessionId?: string;
    sessionKey?: string;
    milestone: string;
  }) => void;
} {
  if (!options.profilerEnabled) {
    // This tracker wraps the agent-turn hot path. Without an explicit profiler
    // flag, keep every wrapper pass-through so normal turns avoid Date.now and
    // span-array work entirely.
    return {
      async measure(_name, run) {
        return await run();
      },
      measureSync(_name, run) {
        return run();
      },
      logIfSlow() {},
      logMilestoneIfSlow() {},
    };
  }

  const startedAt = Date.now();
  let didLog = false;
  const spans: AgentTurnTimingSpan[] = [];
  const toMs = (value: number) => Math.max(0, Math.round(value));
  const record = (name: string, spanStartedAt: number) => {
    spans.push({
      name,
      durationMs: toMs(Date.now() - spanStartedAt),
      elapsedMs: toMs(Date.now() - startedAt),
    });
  };
  const snapshot = (): AgentTurnTimingSummary => ({
    totalMs: toMs(Date.now() - startedAt),
    spans: spans.slice(),
  });
  const shouldLog = (summary: AgentTurnTimingSummary) =>
    summary.totalMs >= AGENT_TURN_TIMING_WARN_TOTAL_MS ||
    summary.spans.some((span) => span.durationMs >= AGENT_TURN_TIMING_WARN_STAGE_MS);
  const formatSpans = (summary: AgentTurnTimingSummary) =>
    summary.spans.length > 0
      ? summary.spans
          .map((span) => `${span.name}:${span.durationMs}ms@${span.elapsedMs}ms`)
          .join(",")
      : "none";
  return {
    async measure(name, run) {
      const spanStartedAt = Date.now();
      try {
        return await run();
      } finally {
        record(name, spanStartedAt);
      }
    },
    measureSync(name, run) {
      const spanStartedAt = Date.now();
      try {
        return run();
      } finally {
        record(name, spanStartedAt);
      }
    },
    logIfSlow(params) {
      if (didLog) {
        return;
      }
      const summary = snapshot();
      if (!shouldLog(summary)) {
        return;
      }
      didLog = true;
      agentTurnTimingLog.warn(
        `agent turn timings runId=${params.runId} sessionId=${
          params.sessionId ?? "unknown"
        } sessionKey=${params.sessionKey ?? "unknown"} outcome=${params.outcome} totalMs=${
          summary.totalMs
        } stages=${formatSpans(summary)}${params.error ? ` error="${params.error}"` : ""}`,
        {
          runId: params.runId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          outcome: params.outcome,
          error: params.error,
          totalMs: summary.totalMs,
          spans: summary.spans,
        },
      );
    },
    logMilestoneIfSlow(params) {
      if (!options.profilerEnabled) {
        return;
      }
      const summary = snapshot();
      if (!shouldLog(summary)) {
        return;
      }
      agentTurnTimingLog.warn(
        `agent turn milestone runId=${params.runId} sessionId=${
          params.sessionId ?? "unknown"
        } sessionKey=${params.sessionKey ?? "unknown"} milestone=${params.milestone} totalMs=${
          summary.totalMs
        } stages=${formatSpans(summary)}`,
        {
          runId: params.runId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          milestone: params.milestone,
          totalMs: summary.totalMs,
          spans: summary.spans,
        },
      );
    },
  };
}

function readApprovalScopeValue(value: unknown): "turn" | "session" | undefined {
  return value === "turn" || value === "session" ? value : undefined;
}

function readRecordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readFiniteNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNullableNumberValue(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return readFiniteNumberValue(value);
}

function isCommandToolName(name: string | undefined): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(name);
  return normalized === "exec" || normalized === "bash" || normalized === "shell";
}

export function buildCommandOutputFromToolResultEvent(evt: {
  stream: string;
  data: Record<string, unknown>;
}): Parameters<NonNullable<GetReplyOptions["onCommandOutput"]>>[0] | undefined {
  if (evt.stream !== "tool" || readStringValue(evt.data.phase) !== "result") {
    return undefined;
  }
  const name = readStringValue(evt.data.name);
  if (!isCommandToolName(name)) {
    return undefined;
  }
  const result = readRecordValue(evt.data.result);
  const details = readRecordValue(result?.details);
  const output =
    readStringValue(evt.data.output) ??
    readStringValue(result?.output) ??
    readStringValue(details?.output);
  const explicitStatus =
    readStringValue(evt.data.status) ??
    readStringValue(result?.status) ??
    readStringValue(details?.status);
  const exitCode = readNullableNumberValue(
    result?.exitCode ?? details?.exitCode ?? evt.data.exitCode,
  );
  const durationMs = readFiniteNumberValue(
    result?.durationMs ?? details?.durationMs ?? evt.data.durationMs,
  );
  const cwd = readStringValue(evt.data.cwd);
  const hasConcreteCommandResult =
    output !== undefined ||
    explicitStatus !== undefined ||
    exitCode !== undefined ||
    durationMs !== undefined ||
    cwd !== undefined ||
    (result !== undefined && Object.keys(result).length > 0);
  if (!hasConcreteCommandResult) {
    return undefined;
  }
  const errorStatus =
    evt.data.isError === true ? "failed" : evt.data.isError === false ? "completed" : undefined;
  const status = explicitStatus ?? errorStatus;
  return {
    itemId: readStringValue(evt.data.itemId),
    phase: "end",
    title: readStringValue(evt.data.title),
    toolCallId: readStringValue(evt.data.toolCallId),
    name,
    output,
    status,
    exitCode,
    durationMs,
    cwd,
  };
}

/** One attempted runtime fallback candidate and its failure reason. */
export type RuntimeFallbackAttempt = {
  provider: string;
  model: string;
  error: string;
  reason?: string;
  status?: number;
  code?: string;
};

/** Result of running an agent turn through fallback/retry handling. */
export type AgentRunLoopResult =
  | {
      kind: "success";
      runId: string;
      runResult: EmbeddedAgentRunResult;
      fallbackProvider?: string;
      fallbackModel?: string;
      fallbackExhausted?: true;
      fallbackAttempts: RuntimeFallbackAttempt[];
      didLogHeartbeatStrip: boolean;
      autoCompactionCount: number;
      compactionTraceparent?: string;
      /** Payload keys sent directly (not via pipeline) during tool flush. */
      continueWorkRequests?: import("../../agents/tools/continue-work-tool.js").ContinueWorkRequest[];
      directlySentBlockKeys?: Set<string>;
      /** Payloads successfully sent directly during tool flush. */
      directlySentBlockPayloads?: ReplyPayload[];
      /** Prepared terminal failure, appended only after delivery evidence settles. */
      terminalFailurePayload?: ReplyPayload;
    }
  | { kind: "final"; payload: ReplyPayload };

type FallbackSelectionState = Pick<
  SessionEntry,
  | "providerOverride"
  | "modelOverride"
  | "modelOverrideSource"
  | "modelOverrideFallbackOriginProvider"
  | "modelOverrideFallbackOriginModel"
  | "authProfileOverride"
  | "authProfileOverrideSource"
  | "authProfileOverrideCompactionCount"
>;

const FALLBACK_SELECTION_STATE_KEYS = [
  "providerOverride",
  "modelOverride",
  "modelOverrideSource",
  "modelOverrideFallbackOriginProvider",
  "modelOverrideFallbackOriginModel",
  "authProfileOverride",
  "authProfileOverrideSource",
  "authProfileOverrideCompactionCount",
] as const satisfies ReadonlyArray<keyof FallbackSelectionState>;

function setFallbackSelectionStateField(
  entry: SessionEntry,
  key: keyof FallbackSelectionState,
  value: FallbackSelectionState[keyof FallbackSelectionState],
): boolean {
  switch (key) {
    case "providerOverride":
      if (entry.providerOverride !== value) {
        entry.providerOverride = value as SessionEntry["providerOverride"];
        return true;
      }
      return false;
    case "modelOverride":
      if (entry.modelOverride !== value) {
        entry.modelOverride = value as SessionEntry["modelOverride"];
        return true;
      }
      return false;
    case "modelOverrideSource":
      if (entry.modelOverrideSource !== value) {
        entry.modelOverrideSource = value as SessionEntry["modelOverrideSource"];
        return true;
      }
      return false;
    case "modelOverrideFallbackOriginProvider":
      if (entry.modelOverrideFallbackOriginProvider !== value) {
        entry.modelOverrideFallbackOriginProvider =
          value as SessionEntry["modelOverrideFallbackOriginProvider"];
        return true;
      }
      return false;
    case "modelOverrideFallbackOriginModel":
      if (entry.modelOverrideFallbackOriginModel !== value) {
        entry.modelOverrideFallbackOriginModel =
          value as SessionEntry["modelOverrideFallbackOriginModel"];
        return true;
      }
      return false;
    case "authProfileOverride":
      if (entry.authProfileOverride !== value) {
        entry.authProfileOverride = value as SessionEntry["authProfileOverride"];
        return true;
      }
      return false;
    case "authProfileOverrideSource":
      if (entry.authProfileOverrideSource !== value) {
        entry.authProfileOverrideSource = value as SessionEntry["authProfileOverrideSource"];
        return true;
      }
      return false;
    case "authProfileOverrideCompactionCount":
      if (entry.authProfileOverrideCompactionCount !== value) {
        entry.authProfileOverrideCompactionCount =
          value as SessionEntry["authProfileOverrideCompactionCount"];
        return true;
      }
      return false;
  }
  throw new Error("Unsupported fallback selection state key");
}

function snapshotFallbackSelectionState(entry: SessionEntry): FallbackSelectionState {
  return {
    providerOverride: entry.providerOverride,
    modelOverride: entry.modelOverride,
    modelOverrideSource: entry.modelOverrideSource,
    modelOverrideFallbackOriginProvider: entry.modelOverrideFallbackOriginProvider,
    modelOverrideFallbackOriginModel: entry.modelOverrideFallbackOriginModel,
    authProfileOverride: entry.authProfileOverride,
    authProfileOverrideSource: entry.authProfileOverrideSource,
    authProfileOverrideCompactionCount: entry.authProfileOverrideCompactionCount,
  };
}

function buildFallbackSelectionStatePatch(entry: SessionEntry): Partial<SessionEntry> {
  return {
    ...snapshotFallbackSelectionState(entry),
    updatedAt: entry.updatedAt,
  };
}

function buildFallbackSelectionState(params: {
  provider: string;
  model: string;
  originProvider: string;
  originModel: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
}): FallbackSelectionState {
  return {
    providerOverride: params.provider,
    modelOverride: params.model,
    modelOverrideSource: "auto",
    modelOverrideFallbackOriginProvider: params.originProvider,
    modelOverrideFallbackOriginModel: params.originModel,
    authProfileOverride: params.authProfileId,
    authProfileOverrideSource: params.authProfileId ? params.authProfileIdSource : undefined,
    authProfileOverrideCompactionCount: undefined,
  };
}

function resolveFallbackSelectionOrigin(params: { entry: SessionEntry; run: FollowupRun["run"] }): {
  provider: string;
  model: string;
} {
  if (
    params.entry.modelOverrideSource === "auto" ||
    (params.entry.modelOverrideSource === undefined &&
      hasSessionAutoModelFallbackProvenance(params.entry))
  ) {
    const persistedOriginProvider = normalizeOptionalString(
      params.entry.modelOverrideFallbackOriginProvider,
    );
    const persistedOriginModel = normalizeOptionalString(
      params.entry.modelOverrideFallbackOriginModel,
    );
    if (persistedOriginProvider && persistedOriginModel) {
      return { provider: persistedOriginProvider, model: persistedOriginModel };
    }
  }
  return { provider: params.run.provider, model: params.run.model };
}

/** Persists the fallback candidate selection onto a session entry. */
export function applyFallbackCandidateSelectionToEntry(params: {
  entry: SessionEntry;
  run: FollowupRun["run"];
  provider: string;
  model: string;
  origin?: { provider: string; model: string };
  force?: boolean;
  now?: number;
}): { updated: boolean; nextState?: FallbackSelectionState } {
  if (
    !params.force &&
    params.provider === params.run.provider &&
    params.model === params.run.model
  ) {
    return { updated: false };
  }
  const scopedAuthProfile = resolveRunAuthProfile(params.run, params.provider);
  const origin =
    params.origin ?? resolveFallbackSelectionOrigin({ entry: params.entry, run: params.run });
  const nextState = buildFallbackSelectionState({
    provider: params.provider,
    model: params.model,
    originProvider: origin.provider,
    originModel: origin.model,
    authProfileId: scopedAuthProfile.authProfileId,
    authProfileIdSource: scopedAuthProfile.authProfileIdSource,
  });
  return {
    updated: applyFallbackSelectionState(params.entry, nextState, params.now),
    nextState,
  };
}

function applyFallbackSelectionState(
  entry: SessionEntry,
  nextState: FallbackSelectionState,
  now = Date.now(),
): boolean {
  let updated = false;
  for (const key of FALLBACK_SELECTION_STATE_KEYS) {
    const nextValue = nextState[key];
    if (nextValue === undefined) {
      if (Object.hasOwn(entry, key)) {
        delete entry[key];
        updated = true;
      }
      continue;
    }
    if (entry[key] !== nextValue) {
      updated = setFallbackSelectionStateField(entry, key, nextValue) || updated;
    }
  }
  if (updated) {
    entry.updatedAt = now;
  }
  return updated;
}

function rollbackFallbackSelectionStateIfUnchanged(
  entry: SessionEntry,
  expectedState: FallbackSelectionState,
  previousState: FallbackSelectionState,
  now = Date.now(),
): boolean {
  let updated = false;
  for (const key of FALLBACK_SELECTION_STATE_KEYS) {
    if (entry[key] !== expectedState[key]) {
      continue;
    }
    const previousValue = previousState[key];
    if (previousValue === undefined) {
      if (Object.hasOwn(entry, key)) {
        delete entry[key];
        updated = true;
      }
      continue;
    }
    if (entry[key] !== previousValue) {
      updated = setFallbackSelectionStateField(entry, key, previousValue) || updated;
    }
  }
  if (updated) {
    entry.updatedAt = now;
  }
  return updated;
}

/**
 * Build a human-friendly rate-limit message from a FallbackSummaryError.
 * Includes a countdown when the soonest cooldown expiry is known.
 */
function buildRateLimitCooldownMessage(err: unknown): string {
  const codexUsageLimitMessage = extractCodexUsageLimitErrorMessage(err);
  if (codexUsageLimitMessage) {
    return codexUsageLimitMessage;
  }
  if (isFallbackSummaryError(err) && hasBillingAttemptSummary(err)) {
    return BILLING_ERROR_USER_MESSAGE;
  }
  const message = formatErrorMessage(err);
  if (isBillingErrorMessage(message)) {
    return BILLING_ERROR_USER_MESSAGE;
  }
  if (!isFallbackSummaryError(err)) {
    if (isPeriodicUsageLimitErrorMessage(message)) {
      const providerMessage = sanitizeUserFacingText(message, { errorContext: true });
      return providerMessage.startsWith("⚠️") ? providerMessage : `⚠️ ${providerMessage}`;
    }
    return "⚠️ All models are temporarily rate-limited. Please try again in a few minutes.";
  }
  const expiry = err.soonestCooldownExpiry;
  const now = Date.now();
  if (typeof expiry === "number" && expiry > now) {
    const secsLeft = Math.max(1, Math.ceil((expiry - now) / 1000));
    if (secsLeft <= 60) {
      return `⚠️ Rate-limited — ready in ~${secsLeft}s. Please wait a moment.`;
    }
    const minsLeft = Math.ceil(secsLeft / 60);
    return `⚠️ Rate-limited — ready in ~${minsLeft} min. Please try again shortly.`;
  }
  return "⚠️ All models are temporarily rate-limited. Please try again in a few minutes.";
}

function resolveBillingFailureReplyText(err: unknown): string {
  const billingFailure = isFallbackSummaryError(err)
    ? err.attempts.find(
        (attempt) =>
          attempt.reason === "billing" &&
          (attempt.authMode === "oauth" || attempt.authMode === "token"),
      )
    : isFailoverError(err) && err.reason === "billing"
      ? err
      : undefined;
  if (
    !billingFailure ||
    (billingFailure.authMode !== "oauth" && billingFailure.authMode !== "token")
  ) {
    return BILLING_ERROR_USER_MESSAGE;
  }
  return formatBillingErrorMessage(
    billingFailure.provider,
    billingFailure.model,
    billingFailure.authMode,
  );
}

function extractCodexUsageLimitErrorMessage(err: unknown): string | undefined {
  if (isFallbackSummaryError(err)) {
    for (const attempt of err.attempts) {
      const message = extractCodexUsageLimitMessage(attempt.error);
      if (message) {
        return `⚠️ ${message}`;
      }
    }
    return undefined;
  }
  const message = extractCodexUsageLimitMessage(formatErrorMessage(err));
  return message ? `⚠️ ${message}` : undefined;
}

function extractCodexUsageLimitMessage(text: string): string | undefined {
  const markers = [
    "You've reached your Codex subscription usage limit.",
    "Codex usage limit reached.",
  ];
  let markerIndex: number | undefined;
  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index >= 0 && (markerIndex === undefined || index < markerIndex)) {
      markerIndex = index;
    }
  }
  if (markerIndex === undefined) {
    return undefined;
  }
  const message = sanitizeUserFacingText(text.slice(markerIndex), { errorContext: true })
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!message) {
    return undefined;
  }
  return message.length > 500 ? `${truncateUtf16Safe(message, 497)}...` : message;
}

function isPureTransientRateLimitSummary(err: unknown): boolean {
  return (
    isFallbackSummaryError(err) &&
    err.attempts.length > 0 &&
    err.attempts.every((attempt) => {
      const reason = attempt.reason;
      return reason === "rate_limit" || reason === "overloaded";
    })
  );
}

function hasBillingAttemptSummary(err: unknown): boolean {
  return (
    isFallbackSummaryError(err) &&
    err.attempts.length > 0 &&
    err.attempts.some((attempt) => attempt.reason === "billing")
  );
}

function collapseRepeatedFailureDetail(message: string): string {
  const parts = message
    .split(/\s+\|\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 2 && parts.every((part) => part === parts[0])) {
    return parts[0];
  }
  return message.trim();
}

const SAFE_MISSING_API_KEY_PROVIDERS = new Set(["anthropic", "google", "openai"]);
const EXTERNAL_RUN_FAILURE_DETAIL_MAX_CHARS = 900;
const AGENT_FAILED_BEFORE_REPLY_TEXT = "Agent failed before reply:";
const PREFLIGHT_COMPACTION_FAILURE_PREFIX = "Preflight compaction required but failed:";

type ExternalRunFailureReply = {
  text: string;
  isGenericRunnerFailure: boolean;
};

type ExternalRunFailureInput = string | { message: string; error?: unknown };

type ExternalFailureConversationContext = Pick<
  TemplateContext,
  "ChatType" | "Provider" | "SessionKey" | "Surface"
>;

function isNonDirectConversationContext(ctx: ExternalFailureConversationContext): boolean {
  const chatType = normalizeLowercaseStringOrEmpty(ctx.ChatType);
  return chatType === "group" || chatType === "channel";
}

function isVerboseFailureDetailEnabled(level: VerboseLevel | undefined): boolean {
  return level === "on" || level === "full";
}

function resolveExternalRunFailureTextForConversation(params: {
  text: string;
  sessionCtx: ExternalFailureConversationContext;
  isGenericRunnerFailure: boolean;
  cfg?: OpenClawConfig;
}): string {
  if (!isNonDirectConversationContext(params.sessionCtx)) {
    return params.text;
  }
  if (!params.isGenericRunnerFailure && !params.text.includes(AGENT_FAILED_BEFORE_REPLY_TEXT)) {
    return params.text;
  }
  // Match normal reply routing: default group/channel failures stay silent,
  // while explicit default or per-surface policy can surface the failure copy.
  const silentPolicy = resolveSilentReplyPolicy({
    cfg: params.cfg,
    sessionKey: params.sessionCtx.SessionKey,
    surface: params.sessionCtx.Surface ?? params.sessionCtx.Provider,
    conversationType: "group",
  });
  if (silentPolicy === "disallow") {
    return params.text;
  }
  return SILENT_REPLY_TOKEN;
}

const CLI_BACKEND_NO_OUTPUT_STALL_RE =
  /\bCLI produced no output for\s+(\d+)\s*s\s+and was terminated\b/iu;
const CLI_BACKEND_OVERALL_TIMEOUT_RE =
  /\bCLI exceeded timeout\s*\(\s*(\d+)\s*s\s*\)\s+and was terminated\b/iu;
const CLI_BACKEND_ROUTING_REF_BEFORE_ERROR_RE = /\b([\w.-]+\/[A-Za-z][\w.-]*)\s*:\s*CLI\b/iu;
const CODEX_APP_SERVER_CLIENT_CLOSED_BEFORE_REPLY_RE =
  /\bcodex app-server client closed before turn completed\b/iu;
const CODEX_APP_SERVER_TURN_COMPLETION_IDLE_TIMEOUT_RE =
  /\bcodex app-server turn idle timed out waiting for turn\/completed\b/iu;

function buildCodexAppServerFailureText(message: string): string | null {
  const normalizedMessage = collapseRepeatedFailureDetail(message);
  if (CODEX_APP_SERVER_CLIENT_CLOSED_BEFORE_REPLY_RE.test(normalizedMessage)) {
    return "⚠️ Codex app-server connection closed before this turn finished. OpenClaw retried once when the stdio turn was still replay-safe; please try again if this keeps happening.";
  }
  if (CODEX_APP_SERVER_TURN_COMPLETION_IDLE_TIMEOUT_RE.test(normalizedMessage)) {
    return "⚠️ Codex app-server stopped before confirming turn completion. OpenClaw did not replay the turn automatically because it may still be active; try again, or use /new if the session stays stuck.";
  }
  return null;
}

/** Formats the reply shown when preflight compaction fails before a run. */
export function buildPreflightCompactionFailureText(
  message: string,
  options?: { includeDetails?: boolean },
): string | null {
  const normalizedMessage = collapseRepeatedFailureDetail(message);
  if (!normalizedMessage.startsWith(PREFLIGHT_COMPACTION_FAILURE_PREFIX)) {
    return null;
  }
  const reason = sanitizeUserFacingText(
    normalizedMessage.slice(PREFLIGHT_COMPACTION_FAILURE_PREFIX.length),
    { errorContext: true },
  )
    .trim()
    .replace(/\s+/gu, " ");
  const reasonSuffix = options?.includeDetails && reason ? ` Reason: ${reason}.` : "";
  return (
    "⚠️ Context is too large and auto-compaction could not recover this turn." +
    `${reasonSuffix} Try again, use /compact, or use /new to start a fresh session.`
  );
}

function buildCliBackendTimeoutFailureText(message: string): string | null {
  const normalizedMessage = collapseRepeatedFailureDetail(message);
  const stall = normalizedMessage.match(CLI_BACKEND_NO_OUTPUT_STALL_RE);
  const overall = normalizedMessage.match(CLI_BACKEND_OVERALL_TIMEOUT_RE);
  const timeout = stall ?? overall;
  const seconds = timeout?.[1];
  if (!seconds) {
    return null;
  }
  const routedModelRef = normalizedMessage.match(CLI_BACKEND_ROUTING_REF_BEFORE_ERROR_RE)?.[1];
  const routingSuffix = routedModelRef ? ` (routing ${routedModelRef})` : "";
  const modeLabel = stall ? "no-output stall" : "overall CLI turn budget";
  return (
    `⚠️ CLI subprocess${routingSuffix}: timed out after ${seconds}s (${modeLabel}). The gateway may still be healthy. Try \`/new\`, a lighter model, or raise ` +
    "`agents.defaults.timeoutSeconds` and the watchdog `noOutputTimeoutMs` entries under `cliBackends.<your-runtime>`."
  );
}

function buildMissingApiKeyFailureText(input: { message: string; error?: unknown }): string | null {
  const normalizedMessage = collapseRepeatedFailureDetail(input.message);
  const provider = isMissingProviderAuthError(input.error)
    ? input.error.provider.trim().toLowerCase()
    : normalizedMessage
        .match(/No API key found for provider "([^"]+)"/u)?.[1]
        ?.trim()
        .toLowerCase();
  if (!provider) {
    return null;
  }
  if (provider === "openai" && normalizedMessage.includes("OpenAI Codex OAuth")) {
    return "⚠️ Missing API key for OpenAI on the gateway. Use `openai/gpt-5.5` with the OpenAI OAuth profile, or set `OPENAI_API_KEY` for direct OpenAI API-key runs.";
  }
  if (provider === "openai") {
    return '⚠️ Missing API key for provider "openai". Run `openclaw doctor --fix` to repair stale OpenAI model/session routes, restart the gateway if doctor asks, then try again. If doctor has nothing to repair or the error persists, re-auth with `openclaw models auth login --provider openai` or run `openclaw configure`.';
  }
  if (SAFE_MISSING_API_KEY_PROVIDERS.has(provider)) {
    return `⚠️ Missing API key for provider "${provider}". Configure the gateway auth for that provider, then try again.`;
  }
  return "⚠️ Missing API key for the selected provider on the gateway. Configure provider auth, then try again.";
}

function buildAuthProfileFailoverFailureText(error: unknown): string | null {
  if (!isFailoverError(error) || !error.provider || !error.authProfileFailure) {
    return null;
  }
  return formatAuthProfileFailureMessage({
    reason: error.reason,
    provider: error.provider,
    allInCooldown: error.authProfileFailure.allInCooldown,
    cause: error.cause,
  });
}

function formatForwardedExternalRunFailureText(message: string): string {
  const sanitized = sanitizeUserFacingText(message, { errorContext: true })
    .trim()
    .replace(/^⚠️\s*/u, "")
    .replace(/\s+/gu, " ");
  if (!sanitized) {
    return GENERIC_EXTERNAL_RUN_FAILURE_TEXT;
  }
  const detail =
    sanitized.length > EXTERNAL_RUN_FAILURE_DETAIL_MAX_CHARS
      ? `${truncateUtf16Safe(sanitized, EXTERNAL_RUN_FAILURE_DETAIL_MAX_CHARS - 1).trimEnd()}…`
      : sanitized;
  const suffix = /[.!?]$/u.test(detail) ? "" : ".";
  return `⚠️ Agent failed before reply: ${detail}${suffix} Please try again, or use /new to start a fresh session.`;
}

function supportsChannelCodexLogin(provider: string | null | undefined): boolean {
  if (!provider) {
    return false;
  }
  const normalizedProvider = provider.trim().toLowerCase().replace(/_/gu, "-");
  return (
    normalizedProvider === "openai" ||
    normalizedProvider === "codex" ||
    normalizedProvider === "openai-codex"
  );
}

function buildExternalRunFailureReply(
  input: ExternalRunFailureInput,
  options?: {
    includeAuthProfileId?: boolean;
    includeDetails?: boolean;
    isHeartbeat?: boolean;
  },
): ExternalRunFailureReply {
  const message = typeof input === "string" ? input : input.message;
  const error = typeof input === "string" ? undefined : input.error;
  const normalizedMessage = collapseRepeatedFailureDetail(message);
  // OAuth refresh failure is classified before the generic provider-auth check:
  // a FailoverError with reason:"auth" and status:401 (e.g. from the claude-cli
  // subprocess when its stored OAuth token has expired) would otherwise match
  // classifyProviderRequestError and surface the generic provider-auth copy
  // instead of the targeted re-auth command for the affected provider.
  const oauthRefreshFailure =
    classifyOAuthRefreshFailureError(error) ?? classifyOAuthRefreshFailure(normalizedMessage);
  if (oauthRefreshFailure) {
    const loginCommand = buildOAuthRefreshFailureLoginCommand(oauthRefreshFailure.provider, {
      profileId: options?.includeAuthProfileId ? oauthRefreshFailure.profileId : undefined,
    });
    const loginCommandMarkdown = formatOAuthRefreshFailureLoginCommandMarkdown(loginCommand);
    const providerText = oauthRefreshFailure.provider ? ` for ${oauthRefreshFailure.provider}` : "";
    const supportsCodexLogin = supportsChannelCodexLogin(oauthRefreshFailure.provider);
    const channelLoginHint = supportsCodexLogin
      ? "Send `/login codex` from a private chat or Web UI session to pair a new Codex login, or re-auth"
      : "Re-auth";
    const retryLoginHint = supportsCodexLogin
      ? "send `/login codex` from a private chat or Web UI session to pair a new Codex login, or re-auth"
      : "re-auth";
    if (oauthRefreshFailure.reason) {
      return {
        text: `⚠️ Model login expired on the gateway${providerText}. ${channelLoginHint} with ${loginCommandMarkdown} in a terminal, then try again.`,
        isGenericRunnerFailure: false,
      };
    }
    return {
      text: `⚠️ Model login failed on the gateway${providerText}. Please try again. If this keeps happening, ${retryLoginHint} with ${loginCommandMarkdown} in a terminal.`,
      isGenericRunnerFailure: false,
    };
  }
  const authProfileFailoverFailure = buildAuthProfileFailoverFailureText(error);
  if (authProfileFailoverFailure) {
    return { text: authProfileFailoverFailure, isGenericRunnerFailure: false };
  }
  const providerRequestError = classifyProviderRequestError(error ?? normalizedMessage);
  if (providerRequestError) {
    return {
      text: providerRequestError.userMessage,
      isGenericRunnerFailure: false,
    };
  }
  const missingApiKeyFailure = buildMissingApiKeyFailureText({
    message: normalizedMessage,
    error,
  });
  if (missingApiKeyFailure) {
    return { text: missingApiKeyFailure, isGenericRunnerFailure: false };
  }
  if (options?.isHeartbeat) {
    return { text: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT, isGenericRunnerFailure: false };
  }
  const cliBackendTimeoutFailure = buildCliBackendTimeoutFailureText(normalizedMessage);
  if (cliBackendTimeoutFailure) {
    return { text: cliBackendTimeoutFailure, isGenericRunnerFailure: false };
  }
  const codexAppServerFailure = buildCodexAppServerFailureText(normalizedMessage);
  if (codexAppServerFailure) {
    return { text: codexAppServerFailure, isGenericRunnerFailure: false };
  }
  return {
    text: options?.includeDetails
      ? formatForwardedExternalRunFailureText(normalizedMessage)
      : GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
    isGenericRunnerFailure: true,
  };
}

function markAgentRunFailureReplyPayload<T extends ReplyPayload>(payload: T): T {
  const marked = markReplyPayloadForSourceSuppressionDelivery(payload);
  if (!isSilentReplyText(marked.text, SILENT_REPLY_TOKEN)) {
    marked.isError = true;
  }
  return marked;
}

export function buildTerminalAgentRunFailureReplyPayload(params: {
  isHeartbeat?: boolean;
  sessionCtx: ExternalFailureConversationContext;
  cfg?: OpenClawConfig;
}): ReplyPayload {
  return markAgentRunFailureReplyPayload({
    text: resolveExternalRunFailureTextForConversation({
      text: params.isHeartbeat
        ? HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT
        : GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
      sessionCtx: params.sessionCtx,
      isGenericRunnerFailure: true,
      cfg: params.cfg,
    }),
  });
}

export function buildEmptyInteractiveReplyPayload(params: {
  isInteractive: boolean;
  isHeartbeat?: boolean;
  silentExpected?: boolean;
  allowEmptyAssistantReplyAsSilent?: boolean;
  isMessageToolOnly: boolean;
  hasPendingContinuation: boolean;
  hasExplicitSilentReply: boolean;
  hasCommittedDelivery: boolean;
  sessionCtx: ExternalFailureConversationContext;
  cfg?: OpenClawConfig;
}): ReplyPayload | undefined {
  if (
    !params.isInteractive ||
    params.isHeartbeat === true ||
    params.silentExpected === true ||
    params.allowEmptyAssistantReplyAsSilent === true ||
    params.isMessageToolOnly ||
    params.hasPendingContinuation ||
    params.hasExplicitSilentReply ||
    params.hasCommittedDelivery
  ) {
    return undefined;
  }
  return markAgentRunFailureReplyPayload({
    text: resolveExternalRunFailureTextForConversation({
      text: "I finished the turn, but it did not produce a visible reply. Please try again, or start a new session if this keeps happening.",
      sessionCtx: params.sessionCtx,
      isGenericRunnerFailure: true,
      cfg: params.cfg,
    }),
  });
}

/** Converts known agent-run failures into user-facing reply payloads. */
export function buildKnownAgentRunFailureReplyPayload(params: {
  err: unknown;
  sessionCtx: TemplateContext;
  resolvedVerboseLevel: VerboseLevel | undefined;
  cfg?: OpenClawConfig;
}): ReplyPayload | undefined {
  const message = formatErrorMessage(params.err);
  const isFallbackSummary = isFallbackSummaryError(params.err);
  const isBilling = isFallbackSummary
    ? hasBillingAttemptSummary(params.err)
    : isFailoverError(params.err)
      ? params.err.reason === "billing"
      : isBillingErrorMessage(message);
  if (isBilling) {
    return markAgentRunFailureReplyPayload({
      text: resolveExternalRunFailureTextForConversation({
        text: resolveBillingFailureReplyText(params.err),
        sessionCtx: params.sessionCtx,
        isGenericRunnerFailure: false,
        cfg: params.cfg,
      }),
    });
  }

  const preflightCompactionFailureText = buildPreflightCompactionFailureText(message, {
    includeDetails: isVerboseFailureDetailEnabled(params.resolvedVerboseLevel),
  });
  if (preflightCompactionFailureText) {
    return markAgentRunFailureReplyPayload({
      text: resolveExternalRunFailureTextForConversation({
        text: preflightCompactionFailureText,
        sessionCtx: params.sessionCtx,
        isGenericRunnerFailure: false,
        cfg: params.cfg,
      }),
    });
  }

  const isPureTransientSummary = isFallbackSummary
    ? isPureTransientRateLimitSummary(params.err)
    : false;
  const failoverReason =
    !isFallbackSummary && isFailoverError(params.err) ? params.err.reason : undefined;
  const isOverloaded = failoverReason === "overloaded" || isOverloadedErrorMessage(message);
  const isRateLimit = isFallbackSummary
    ? isPureTransientSummary
    : failoverReason
      ? failoverReason === "rate_limit" || failoverReason === "overloaded"
      : isRateLimitErrorMessage(message);
  const rateLimitOrOverloadedCopy =
    !isFallbackSummary || isPureTransientSummary
      ? formatRateLimitOrOverloadedErrorCopy(
          failoverReason === "overloaded" ? "overloaded" : message,
        )
      : undefined;

  if (isRateLimit && !isOverloaded) {
    return markAgentRunFailureReplyPayload({
      text: resolveExternalRunFailureTextForConversation({
        text: buildRateLimitCooldownMessage(params.err),
        sessionCtx: params.sessionCtx,
        isGenericRunnerFailure: false,
        cfg: params.cfg,
      }),
    });
  }

  if (rateLimitOrOverloadedCopy) {
    return markAgentRunFailureReplyPayload({
      text: resolveExternalRunFailureTextForConversation({
        text: rateLimitOrOverloadedCopy,
        sessionCtx: params.sessionCtx,
        isGenericRunnerFailure: false,
        cfg: params.cfg,
      }),
    });
  }

  const externalRunFailureReply = buildExternalRunFailureReply(
    { message, error: params.err },
    {
      includeAuthProfileId: !isNonDirectConversationContext(params.sessionCtx),
      includeDetails: isVerboseFailureDetailEnabled(params.resolvedVerboseLevel),
    },
  );
  if (externalRunFailureReply.isGenericRunnerFailure) {
    return undefined;
  }
  return markAgentRunFailureReplyPayload({
    text: resolveExternalRunFailureTextForConversation({
      text: externalRunFailureReply.text,
      sessionCtx: params.sessionCtx,
      isGenericRunnerFailure: false,
      cfg: params.cfg,
    }),
  });
}

const DEFAULT_RESERVE_TOKENS_FLOOR = 20_000;

/** Computes a reserve-token floor scaled to the selected context window. */
export function computeContextAwareReserveTokensFloor(contextWindow: number | undefined): number {
  if (typeof contextWindow !== "number" || contextWindow <= 0) {
    return DEFAULT_RESERVE_TOKENS_FLOOR;
  }
  if (contextWindow >= 1_000_000) {
    return 100_000;
  }
  if (contextWindow >= 200_000) {
    return 50_000;
  }
  if (contextWindow >= 100_000) {
    return 35_000;
  }
  return DEFAULT_RESERVE_TOKENS_FLOOR;
}

function resolveContextWindowForCompactionHint(params: {
  cfg: FollowupRun["run"]["config"];
  primaryProvider?: string;
  primaryModel?: string;
  runtimeProvider?: string;
  runtimeModel?: string;
  agentId?: string;
  activeSessionEntry?: SessionEntry;
}): number | undefined {
  let modelWindow: number | undefined;
  const entryProvider = params.activeSessionEntry?.modelProvider;
  const entryModel = params.activeSessionEntry?.model;
  const runtimeProvider = params.runtimeProvider ?? entryProvider;
  const runtimeModel = params.runtimeModel ?? entryModel;
  const hasExplicitRuntimeRef = Boolean(params.runtimeProvider && params.runtimeModel);
  if (runtimeProvider && runtimeModel) {
    const resolved = resolveContextTokensForModel({
      cfg: params.cfg,
      provider: runtimeProvider,
      model: runtimeModel,
      allowAsyncLoad: false,
    });
    if (typeof resolved === "number" && resolved > 0) {
      modelWindow = resolved;
    }
  }
  const sessionWindow = normalizePositiveContextTokens(params.activeSessionEntry?.contextTokens);
  const sessionMatchesRuntimeRef = runtimeProvider === entryProvider && runtimeModel === entryModel;
  const trustedSessionWindow =
    !hasExplicitRuntimeRef || sessionMatchesRuntimeRef ? sessionWindow : undefined;
  if (modelWindow === undefined && sessionMatchesRuntimeRef && sessionWindow !== undefined) {
    modelWindow = sessionWindow;
  }
  if (
    modelWindow === undefined &&
    !hasExplicitRuntimeRef &&
    params.primaryProvider &&
    params.primaryModel
  ) {
    const resolved = resolveContextTokensForModel({
      cfg: params.cfg,
      provider: params.primaryProvider,
      model: params.primaryModel,
      allowAsyncLoad: false,
    });
    if (typeof resolved === "number" && resolved > 0) {
      modelWindow = resolved;
    }
  }
  const contextWindow = modelWindow ?? trustedSessionWindow;
  const agentCap = resolveAgentContextTokensForHint({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (agentCap !== undefined && contextWindow !== undefined) {
    return Math.min(agentCap, contextWindow);
  }
  return agentCap ?? contextWindow;
}

function buildContextOverflowResetHint(contextWindowTokens: number | undefined): string {
  const reserveFloor = computeContextAwareReserveTokensFloor(contextWindowTokens);
  return (
    "\n\nTo prevent this, increase your compaction buffer by setting " +
    `\`agents.defaults.compaction.reserveTokensFloor\` to ${reserveFloor} or higher in your config.`
  );
}

type ModelRefLike = {
  provider: string;
  model: string;
};

function resolveAgentHeartbeatModelRaw(params: {
  cfg: FollowupRun["run"]["config"];
  agentId?: string;
}): string | undefined {
  const defaultModel = normalizeOptionalString(params.cfg.agents?.defaults?.heartbeat?.model);
  const agentId = normalizeLowercaseStringOrEmpty(params.agentId);
  const agentModel = agentId
    ? normalizeOptionalString(
        params.cfg.agents?.list?.find(
          (entry) => normalizeLowercaseStringOrEmpty(entry?.id) === agentId,
        )?.heartbeat?.model,
      )
    : undefined;
  return agentModel ?? defaultModel;
}

function normalizeModelRefForCompare(ref: ModelRefLike | undefined) {
  if (!ref) {
    return undefined;
  }
  const provider = normalizeLowercaseStringOrEmpty(ref.provider);
  const model = normalizeLowercaseStringOrEmpty(ref.model);
  return provider && model ? { provider, model } : undefined;
}

function modelRefsEqual(left: ModelRefLike | undefined, right: ModelRefLike | undefined) {
  const normalizedLeft = normalizeModelRefForCompare(left);
  const normalizedRight = normalizeModelRefForCompare(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  return (
    normalizedLeft.provider === normalizedRight.provider &&
    normalizedLeft.model === normalizedRight.model
  );
}

function formatContextWindowLabel(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Math.round((tokens / 1_000_000) * 10) / 10}M`;
  }
  return `${Math.round(tokens / 1024)}k`;
}

function normalizePositiveContextTokens(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function resolveAgentContextTokensForHint(params: {
  cfg: FollowupRun["run"]["config"];
  agentId?: string;
}): number | undefined {
  const defaultContextTokens = normalizePositiveContextTokens(
    params.cfg.agents?.defaults?.contextTokens,
  );
  const agentId = normalizeLowercaseStringOrEmpty(params.agentId);
  const agentContextTokens = agentId
    ? normalizePositiveContextTokens(
        params.cfg.agents?.list?.find(
          (entry) => normalizeLowercaseStringOrEmpty(entry?.id) === agentId,
        )?.contextTokens,
      )
    : undefined;
  return agentContextTokens ?? defaultContextTokens;
}

function resolveContextWindowForHint(params: {
  cfg: FollowupRun["run"]["config"];
  agentId?: string;
  ref: ModelRefLike;
  activeSessionEntry?: SessionEntry;
}) {
  const sessionContextTokens = normalizePositiveContextTokens(
    params.activeSessionEntry?.contextTokens,
  );
  const modelContextTokens = resolveContextTokensForModel({
    cfg: params.cfg,
    provider: params.ref.provider,
    model: params.ref.model,
    allowAsyncLoad: false,
  });
  const contextTokens = modelContextTokens ?? sessionContextTokens;
  if (contextTokens === undefined) {
    return undefined;
  }

  const agentContextTokens = resolveAgentContextTokensForHint({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  return agentContextTokens !== undefined
    ? Math.min(agentContextTokens, contextTokens)
    : contextTokens;
}

function resolveHeartbeatBleedHint(params: {
  cfg: FollowupRun["run"]["config"];
  agentId?: string;
  primaryProvider?: string;
  primaryModel?: string;
  activeSessionEntry?: SessionEntry;
}): string | undefined {
  const primaryProvider = normalizeOptionalString(params.primaryProvider);
  const primaryModel = normalizeOptionalString(params.primaryModel);
  if (!primaryProvider || !primaryModel) {
    return undefined;
  }

  const runtimeProvider = normalizeOptionalString(params.activeSessionEntry?.modelProvider);
  const runtimeModel = normalizeOptionalString(params.activeSessionEntry?.model);
  if (!runtimeProvider || !runtimeModel) {
    return undefined;
  }

  const primaryRef = { provider: primaryProvider, model: primaryModel };
  const runtimeRef = { provider: runtimeProvider, model: runtimeModel };
  if (modelRefsEqual(primaryRef, runtimeRef)) {
    return undefined;
  }

  const heartbeatModelRaw = resolveAgentHeartbeatModelRaw({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const heartbeatRef = heartbeatModelRaw
    ? resolveModelRefFromString({
        cfg: params.cfg,
        raw: heartbeatModelRaw,
        defaultProvider: primaryProvider,
      })?.ref
    : undefined;
  if (!modelRefsEqual(runtimeRef, heartbeatRef)) {
    return undefined;
  }

  const runtimeWindow = resolveContextWindowForHint({
    cfg: params.cfg,
    agentId: params.agentId,
    ref: runtimeRef,
    activeSessionEntry: params.activeSessionEntry,
  });
  const primaryWindow = resolveContextWindowForHint({
    cfg: params.cfg,
    agentId: params.agentId,
    ref: primaryRef,
  });
  if (
    typeof runtimeWindow === "number" &&
    typeof primaryWindow === "number" &&
    runtimeWindow >= primaryWindow
  ) {
    return undefined;
  }

  const runtimeLabel =
    typeof runtimeWindow === "number" && runtimeWindow > 0
      ? ` (${formatContextWindowLabel(runtimeWindow)} context)`
      : "";
  return (
    `\n\nThe previous heartbeat turn left this session on ${runtimeProvider}/${runtimeModel}` +
    `${runtimeLabel} instead of ${primaryProvider}/${primaryModel}. This matches the configured ` +
    "`heartbeat.model`, so the overflow is likely heartbeat model bleed rather than a " +
    "compaction-buffer problem. Set `heartbeat.isolatedSession: true`, enable " +
    "`heartbeat.lightContext: true`, or use a heartbeat model with a larger context window."
  );
}

/** Builds recovery instructions for context-overflow failures. */
export function buildContextOverflowRecoveryText(params: {
  duringCompaction?: boolean;
  preserveSessionMapping?: boolean;
  cfg: FollowupRun["run"]["config"];
  agentId?: string;
  primaryProvider?: string;
  primaryModel?: string;
  runtimeProvider?: string;
  runtimeModel?: string;
  activeSessionEntry?: SessionEntry;
}): string {
  const prefix = params.preserveSessionMapping
    ? "⚠️ Auto-compaction could not recover this turn. I kept this conversation mapped to the current session. Please try again, use /compact, or use /new to start a fresh session."
    : params.duringCompaction
      ? "⚠️ Context limit exceeded during compaction. I've reset our conversation to start fresh - please try again."
      : "⚠️ Context limit exceeded. I've reset our conversation to start fresh - please try again.";
  const primaryContextWindow = resolveContextWindowForCompactionHint({
    cfg: params.cfg,
    primaryProvider: params.primaryProvider,
    primaryModel: params.primaryModel,
    runtimeProvider: params.runtimeProvider,
    runtimeModel: params.runtimeModel,
    agentId: params.agentId,
    activeSessionEntry: params.activeSessionEntry,
  });
  const explicitRuntimeMatchesSession =
    !params.runtimeProvider ||
    !params.runtimeModel ||
    (params.runtimeProvider === params.activeSessionEntry?.modelProvider &&
      params.runtimeModel === params.activeSessionEntry?.model);
  const heartbeatBleedHint = explicitRuntimeMatchesSession
    ? resolveHeartbeatBleedHint({
        cfg: params.cfg,
        agentId: params.agentId,
        primaryProvider: params.primaryProvider,
        primaryModel: params.primaryModel,
        activeSessionEntry: params.activeSessionEntry,
      })
    : undefined;
  return prefix + (heartbeatBleedHint ?? buildContextOverflowResetHint(primaryContextWindow));
}

function buildRestartLifecycleReplyText(): string {
  return "⚠️ Gateway is restarting. Please wait a few seconds and try again.";
}

function resolveRestartLifecycleError(
  err: unknown,
): GatewayDrainingError | CommandLaneClearedError | undefined {
  const pending = [err];
  const seen = new Set<unknown>();

  let pendingIndex = 0;
  while (pendingIndex < pending.length) {
    const candidate = pending[pendingIndex++];
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    if (candidate instanceof GatewayDrainingError || candidate instanceof CommandLaneClearedError) {
      return candidate;
    }

    if (isFallbackSummaryError(candidate)) {
      for (const attempt of candidate.attempts) {
        pending.push(attempt.error);
      }
    }

    if (candidate instanceof Error && "cause" in candidate) {
      pending.push(candidate.cause);
    }
  }

  return undefined;
}

function isReplyOperationUserAbort(replyOperation?: ReplyOperation): boolean {
  if (
    replyOperation?.result?.kind === "aborted" &&
    replyOperation.result.code === "aborted_by_user"
  ) {
    return true;
  }
  const abortSignal = replyOperation?.abortSignal;
  return abortSignal?.aborted === true && !isAgentRunRestartAbortReason(abortSignal.reason);
}

function isReplyOperationRestartAbort(replyOperation?: ReplyOperation): boolean {
  if (
    replyOperation?.result?.kind === "aborted" &&
    replyOperation.result.code === "aborted_for_restart"
  ) {
    return true;
  }
  const abortSignal = replyOperation?.abortSignal;
  return abortSignal?.aborted === true && isAgentRunRestartAbortReason(abortSignal.reason);
}

function emitModelFallbackStepLifecycle(params: {
  runId: string;
  sessionKey?: string;
  step: Record<string, unknown>;
}) {
  emitAgentEvent({
    runId: params.runId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    stream: "lifecycle",
    data: {
      phase: "fallback_step",
      ...params.step,
    },
  });
}

/** Decides whether to retry after rechecking auto-fallback primary probe state. */
export function resolveRunAfterAutoFallbackPrimaryProbeRecheck(params: {
  run: FollowupRun["run"];
  entry?: SessionEntry;
  sessionKey?: string;
}): FollowupRun["run"] {
  const probe = params.run.autoFallbackPrimaryProbe;
  if (!probe || !params.sessionKey) {
    return params.run;
  }
  if (!params.entry) {
    return params.run;
  }
  const resolveEntrySelectionRun = (): FollowupRun["run"] => {
    const entryRef = resolvePersistedOverrideModelRef({
      defaultProvider: params.run.provider,
      overrideProvider: params.entry?.providerOverride,
      overrideModel: params.entry?.modelOverride,
    });
    const hasEntryModelOverride = Boolean(entryRef);
    const authProfileId = normalizeOptionalString(params.entry?.authProfileOverride);
    const fallbackRun: FollowupRun["run"] = {
      ...params.run,
      provider: entryRef?.provider ?? params.run.provider,
      model: entryRef?.model ?? params.run.model,
      autoFallbackPrimaryProbe: undefined,
    };
    if (hasEntryModelOverride) {
      fallbackRun.hasSessionModelOverride = true;
      fallbackRun.hasAutoFallbackProvenance =
        hasSessionAutoModelFallbackProvenance(params.entry) || undefined;
    } else {
      delete fallbackRun.hasSessionModelOverride;
      delete fallbackRun.hasAutoFallbackProvenance;
    }
    if (hasEntryModelOverride && params.entry?.modelOverrideSource) {
      fallbackRun.modelOverrideSource = params.entry.modelOverrideSource;
    } else {
      delete fallbackRun.modelOverrideSource;
    }
    if (hasEntryModelOverride && authProfileId) {
      fallbackRun.authProfileId = authProfileId;
      if (params.entry?.authProfileOverrideSource) {
        fallbackRun.authProfileIdSource = params.entry.authProfileOverrideSource;
      } else {
        delete fallbackRun.authProfileIdSource;
      }
    } else if (hasEntryModelOverride) {
      delete fallbackRun.authProfileId;
      delete fallbackRun.authProfileIdSource;
    }
    return fallbackRun;
  };
  const refreshedProbe = resolveAutoFallbackPrimaryProbe({
    entry: params.entry,
    sessionKey: params.sessionKey,
    primaryProvider: probe.provider,
    primaryModel: probe.model,
  });
  if (!refreshedProbe) {
    return resolveEntrySelectionRun();
  }
  return {
    ...params.run,
    provider: refreshedProbe.provider,
    model: refreshedProbe.model,
    autoFallbackPrimaryProbe: refreshedProbe,
  };
}

async function runAgentTurnWithFallbackInternal(
  params: {
    commandBody: string;
    transcriptCommandBody?: string;
    followupRun: FollowupRun;
    sessionCtx: TemplateContext;
    replyThreading?: TemplateContext["ReplyThreading"];
    replyOperation?: ReplyOperation;
    opts?: GetReplyOptions;
    typingSignals: TypingSignaler;
    blockReplyPipeline: BlockReplyPipeline | null;
    blockStreamingEnabled: boolean;
    blockReplyChunking?: {
      minChars: number;
      maxChars: number;
      breakPreference: "paragraph" | "newline" | "sentence";
      flushOnParagraph?: boolean;
    };
    resolvedBlockStreamingBreak: "text_end" | "message_end";
    applyReplyToMode: (payload: ReplyPayload) => ReplyPayload;
    shouldEmitToolResult: () => boolean;
    shouldEmitToolOutput: () => boolean;
    pendingToolTasks: Set<Promise<void>>;
    resetSessionAfterCompactionFailure?: (reason: string) => Promise<boolean>;
    resetSessionAfterRoleOrderingConflict: (reason: string) => Promise<boolean>;
    isHeartbeat: boolean;
    sessionKey?: string;
    runtimePolicySessionKey?: string;
    getActiveSessionEntry: () => SessionEntry | undefined;
    activeSessionStore?: Record<string, SessionEntry>;
    storePath?: string;
    resolvedVerboseLevel: VerboseLevel;
    toolProgressDetail?: "explain" | "raw";
    replyMediaContext?: ReplyMediaContext;
    onCompactionNoticePayload?: (payload: ReplyPayload) => Promise<void> | void;
    isRestartRecoveryArmed?: () => boolean;
  },
  commitTerminalOutcome: () => void,
): Promise<AgentRunLoopResult> {
  const TRANSIENT_HTTP_RETRY_DELAY_MS = 2_500;
  let didLogHeartbeatStrip = false;
  let autoCompactionCount = 0;
  // Track payloads sent directly (not via pipeline) during tool flush to avoid duplicates.
  const directlySentBlockKeys = new Set<string>();
  const directlySentBlockPayloads: Array<ReplyPayload | undefined> = [];
  const runnableRun = resolveRunAfterAutoFallbackPrimaryProbeRecheck({
    run: params.followupRun.run,
    entry: params.activeSessionStore?.[params.sessionKey ?? ""] ?? params.getActiveSessionEntry(),
    sessionKey: params.sessionKey,
  });
  if (runnableRun !== params.followupRun.run) {
    params.followupRun.run = runnableRun;
  }
  const runtimeConfig = resolveQueuedReplyRuntimeConfig(runnableRun.config);
  const effectiveRun =
    runtimeConfig === runnableRun.config
      ? runnableRun
      : {
          ...runnableRun,
          config: runtimeConfig,
        };
  const preserveUserFacingSessionState = shouldPreserveUserFacingSessionStateForInputProvenance(
    effectiveRun.inputProvenance,
  );
  const resolveRunForFallbackCandidate = (provider: string, model: string): FollowupRun["run"] => {
    const probe = effectiveRun.autoFallbackPrimaryProbe;
    const isPrimaryProbeCandidate = probe && provider === probe.provider && model === probe.model;
    if (
      probe &&
      provider === probe.fallbackProvider &&
      !isPrimaryProbeCandidate &&
      probe.fallbackAuthProfileId
    ) {
      const candidateRun: FollowupRun["run"] = {
        ...effectiveRun,
        provider,
        model,
        authProfileId: probe.fallbackAuthProfileId,
      };
      if (probe.fallbackAuthProfileIdSource) {
        candidateRun.authProfileIdSource = probe.fallbackAuthProfileIdSource;
      } else {
        delete candidateRun.authProfileIdSource;
      }
      return candidateRun;
    }
    return effectiveRun;
  };
  let liveModelSwitchRuntimeEntry:
    | Pick<SessionEntry, "agentHarnessId" | "agentRuntimeOverride" | "modelSelectionLocked">
    | undefined;
  const applyLiveModelSwitchToRun = (
    run: FollowupRun["run"],
    err: LiveSessionModelSwitchError,
  ): void => {
    run.provider = err.provider;
    run.model = err.model;
    run.authProfileId = err.authProfileId;
    run.authProfileIdSource = err.authProfileId ? err.authProfileIdSource : undefined;
    run.autoFallbackPrimaryProbe = undefined;
    // Keep runtime paired with the error's model/auth winner even if the
    // active in-memory session snapshot lags the persisted directive write.
    liveModelSwitchRuntimeEntry = { agentRuntimeOverride: err.agentRuntimeOverride };
  };

  const runId = params.opts?.runId ?? crypto.randomUUID();
  const agentTurnTiming = createAgentTurnTimingTracker({
    profilerEnabled: isReplyProfilerEnabled({ config: runtimeConfig }),
  });
  const shouldSurfaceToControlUi = isInternalMessageChannel(
    params.followupRun.run.messageProvider ??
      params.sessionCtx.Surface ??
      params.sessionCtx.Provider,
  );
  let lifecycleGeneration = captureAgentRunLifecycleGeneration(runId);
  if (params.sessionKey) {
    registerAgentRunContext(runId, {
      sessionKey: params.sessionKey,
      ...(params.followupRun.run.sessionId ? { sessionId: params.followupRun.run.sessionId } : {}),
      agentId: params.followupRun.run.agentId,
      lifecycleGeneration,
      verboseLevel: params.resolvedVerboseLevel,
      isHeartbeat: params.isHeartbeat,
      isControlUiVisible: shouldSurfaceToControlUi,
    });
  }
  if (isDiagnosticsEnabled(runtimeConfig)) {
    logSessionTurnCreated({
      runId,
      sessionKey: params.sessionKey,
      sessionId: params.followupRun.run.sessionId,
      agentId: params.followupRun.run.agentId,
      channel:
        params.followupRun.run.messageProvider ??
        params.sessionCtx.Surface ??
        params.sessionCtx.Provider,
      trigger: resolveReplyHookTrigger(
        params.isHeartbeat && params.opts?.isHeartbeat !== true
          ? { ...params.opts, isHeartbeat: true }
          : params.opts,
      ),
    });
  }
  let replyMediaContext: ReplyMediaContext;
  let currentTurnImages: Awaited<ReturnType<typeof resolveCurrentTurnImages>>;
  try {
    replyMediaContext =
      params.replyMediaContext ??
      agentTurnTiming.measureSync("reply_media_context", () =>
        createReplyMediaContext({
          cfg: runtimeConfig,
          sessionKey: params.sessionKey,
          workspaceDir: params.followupRun.run.workspaceDir,
          messageProvider: params.followupRun.run.messageProvider,
          accountId:
            params.followupRun.originatingAccountId ?? params.followupRun.run.agentAccountId,
          groupId: params.followupRun.run.groupId,
          groupChannel: params.followupRun.run.groupChannel,
          groupSpace: params.followupRun.run.groupSpace,
          requesterSenderId: params.followupRun.run.senderId,
          requesterSenderName: params.followupRun.run.senderName,
          requesterSenderUsername: params.followupRun.run.senderUsername,
          requesterSenderE164: params.followupRun.run.senderE164,
        }),
      );
    currentTurnImages = await agentTurnTiming.measure("current_turn_images", () =>
      resolveCurrentTurnImages({
        ctx: params.sessionCtx,
        cfg: runtimeConfig,
        images: params.followupRun.images ?? params.opts?.images,
        imageOrder: params.followupRun.imageOrder ?? params.opts?.imageOrder,
      }),
    );
  } catch (error) {
    clearAgentRunContext(runId, lifecycleGeneration);
    throw error;
  }
  let didNotifyAgentRunStart = false;
  const notifyAgentRunStart = () => {
    if (didNotifyAgentRunStart) {
      return;
    }
    didNotifyAgentRunStart = true;
    params.opts?.onAgentRunStart?.(runId);
  };
  const signalExecutionPhaseForTyping = (
    info: Parameters<NonNullable<RunEmbeddedAgentParams["onExecutionPhase"]>>[0],
  ) => {
    const isUserVisibleExecutionActivity =
      info.phase === "turn_accepted" ||
      info.phase === "process_spawned" ||
      info.phase === "model_call_started" ||
      info.phase === "tool_execution_started" ||
      info.phase === "assistant_output_started";
    if (!isUserVisibleExecutionActivity) {
      return;
    }
    notifyAgentRunStart();
    void (
      params.typingSignals.signalExecutionActivity?.() ?? params.typingSignals.signalRunStart()
    ).catch((err: unknown) => {
      logVerbose(`execution phase typing signal failed: ${String(err)}`);
    });
  };
  const currentMessageId = params.sessionCtx.MessageSidFull ?? params.sessionCtx.MessageSid;
  const notifyUserAboutCompaction = shouldNotifyUserAboutCompaction(runtimeConfig);
  let didSurfaceBlockedLivenessState = false;
  const surfaceBlockedLivenessState = async () => {
    if (didSurfaceBlockedLivenessState || !params.opts?.onBlockReply) {
      return;
    }
    const noticePayload = params.applyReplyToMode({
      text: BLOCKED_LIVENESS_NOTICE_TEXT,
      replyToId: currentMessageId,
      replyToCurrent: true,
      isError: true,
    });
    try {
      await params.opts.onBlockReply(noticePayload);
      didSurfaceBlockedLivenessState = true;
    } catch (err) {
      logVerbose(`blocked liveness notice delivery failed (non-fatal): ${String(err)}`);
    }
  };
  const deliverCompactionNoticePayload = async (noticePayload: ReplyPayload, label: string) => {
    const deliver = params.opts?.onBlockReply ?? params.onCompactionNoticePayload;
    if (!deliver) {
      return;
    }
    try {
      await deliver(noticePayload);
    } catch (err) {
      // Non-critical notice delivery failure should not bubble out of the
      // fire-and-forget event handler.
      logVerbose(`compaction ${label} notice delivery failed (non-fatal): ${String(err)}`);
    }
  };
  const sendCompactionNotice = async (phase: "start" | "end" | "incomplete") => {
    await deliverCompactionNoticePayload(
      createCompactionNoticePayload({
        phase,
        currentMessageId,
        applyReplyToMode: params.applyReplyToMode,
      }),
      phase,
    );
  };
  const sendCompactionHookMessages = async (messages: string[]) => {
    const noticePayload = createCompactionHookNoticePayload({
      messages,
      currentMessageId,
      applyReplyToMode: params.applyReplyToMode,
    });
    if (!noticePayload) {
      return;
    }
    await deliverCompactionNoticePayload(noticePayload, "hook");
  };
  const runAbortSignal = params.replyOperation?.abortSignal ?? params.opts?.abortSignal;
  let runResult: EmbeddedAgentRunResult;
  let fallbackProvider = params.followupRun.run.provider;
  let fallbackModel = params.followupRun.run.model;
  let attemptedRuntimeProvider = fallbackProvider;
  let attemptedRuntimeModel = fallbackModel;
  let fallbackAttempts: RuntimeFallbackAttempt[] = [];
  let continueWorkRequests: ContinueWorkRequest[] = [];
  let compactionTraceparent: string | undefined;
  let didResetAfterCompactionFailure = false;
  let fallbackExhausted = false;
  let terminalRunFailed = false;
  let pendingLifecycleTerminal:
    | {
        provider: string;
        model: string;
        backstop: AgentLifecycleTerminalBackstop;
      }
    | undefined;
  const takePendingLifecycleTerminal = () => {
    const terminal = pendingLifecycleTerminal?.backstop;
    pendingLifecycleTerminal = undefined;
    return terminal;
  };
  let transientHttpRetriesRemaining = 1;
  const consumeTransientHttpRetry = () => transientHttpRetriesRemaining-- > 0;
  let liveModelSwitchRetries = 0;
  let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
    params.getActiveSessionEntry()?.systemPromptReport,
  );
  let pendingFallbackCandidateRollback:
    | {
        provider: string;
        model: string;
        rollback: () => Promise<void>;
      }
    | undefined;
  const clearPendingFallbackRollback = (rollback?: () => Promise<void>) => {
    if (!rollback || pendingFallbackCandidateRollback?.rollback === rollback) {
      pendingFallbackCandidateRollback = undefined;
    }
  };
  const rollbackClassifiedFallbackCandidateSelection = async (provider: string, model: string) => {
    const pending = pendingFallbackCandidateRollback;
    if (!pending || pending.provider !== provider || pending.model !== model) {
      return;
    }
    pendingFallbackCandidateRollback = undefined;
    try {
      await pending.rollback();
    } catch (rollbackError) {
      logVerbose(
        `failed to roll back classified fallback candidate selection (non-fatal): ${String(rollbackError)}`,
      );
    }
  };
  const persistFallbackCandidateSelection = async (
    provider: string,
    model: string,
    candidateRun: FollowupRun["run"],
  ): Promise<(() => Promise<void>) | undefined> => {
    if (
      !params.sessionKey ||
      !params.activeSessionStore ||
      preserveUserFacingSessionState ||
      !effectiveRun.autoFallbackPrimaryProbe ||
      (provider === effectiveRun.provider && model === effectiveRun.model)
    ) {
      return undefined;
    }

    const activeSessionEntry =
      params.activeSessionStore[params.sessionKey] ?? params.getActiveSessionEntry();
    if (!activeSessionEntry) {
      return undefined;
    }

    // Preserve explicit user selections; fallback pins are only safe to persist
    // when no user override exists or the current override was auto-selected.
    const isUserModelOverride =
      activeSessionEntry.modelOverrideSource === "user" ||
      (activeSessionEntry.modelOverrideSource === undefined &&
        Boolean(normalizeOptionalString(activeSessionEntry.modelOverride)) &&
        !hasSessionAutoModelFallbackProvenance(activeSessionEntry));
    if (isUserModelOverride) {
      return undefined;
    }

    const previousState = snapshotFallbackSelectionState(activeSessionEntry);
    const selectionRun =
      candidateRun !== effectiveRun && effectiveRun.autoFallbackPrimaryProbe
        ? {
            ...candidateRun,
            provider: candidateRun.provider,
            model: effectiveRun.model,
          }
        : candidateRun;
    const persistedProvider = resolveOpenAIRuntimeProvider({
      provider,
      config: runtimeConfig,
      workspaceDir: params.followupRun.run.workspaceDir,
    });
    const applied = applyFallbackCandidateSelectionToEntry({
      entry: activeSessionEntry,
      run: selectionRun,
      provider: persistedProvider,
      model,
      force: candidateRun !== effectiveRun && Boolean(effectiveRun.autoFallbackPrimaryProbe),
      ...(effectiveRun.autoFallbackPrimaryProbe
        ? {
            origin: {
              provider: effectiveRun.autoFallbackPrimaryProbe.provider,
              model: effectiveRun.autoFallbackPrimaryProbe.model,
            },
          }
        : {}),
    });
    const nextState = applied.nextState;
    if (!applied.updated || !nextState) {
      return undefined;
    }
    params.activeSessionStore[params.sessionKey] = activeSessionEntry;

    try {
      if (params.storePath) {
        await updateSessionEntry(
          { storePath: params.storePath, sessionKey: params.sessionKey },
          (persistedEntry) => {
            applyFallbackSelectionState(persistedEntry, nextState);
            return buildFallbackSelectionStatePatch(persistedEntry);
          },
        );
      }
    } catch (error) {
      rollbackFallbackSelectionStateIfUnchanged(activeSessionEntry, nextState, previousState);
      params.activeSessionStore[params.sessionKey] = activeSessionEntry;
      throw error;
    }

    return async () => {
      const rolledBackInMemory = rollbackFallbackSelectionStateIfUnchanged(
        activeSessionEntry,
        nextState,
        previousState,
      );
      if (rolledBackInMemory) {
        params.activeSessionStore![params.sessionKey!] = activeSessionEntry;
      }
      if (!params.storePath || !params.sessionKey) {
        return;
      }
      await updateSessionEntry(
        { storePath: params.storePath, sessionKey: params.sessionKey },
        (persistedEntry) => {
          if (rollbackFallbackSelectionStateIfUnchanged(persistedEntry, nextState, previousState)) {
            return buildFallbackSelectionStatePatch(persistedEntry);
          }
          return null;
        },
      );
    };
  };
  const clearRecoveredAutoFallbackPrimaryProbe = async (paramsForClear: {
    provider: string;
    model: string;
  }): Promise<void> => {
    if (preserveUserFacingSessionState) {
      return;
    }
    const probe = effectiveRun.autoFallbackPrimaryProbe;
    if (!probe) {
      return;
    }
    if (paramsForClear.provider !== probe.provider || paramsForClear.model !== probe.model) {
      return;
    }
    if (!params.sessionKey || !params.activeSessionStore) {
      return;
    }
    const activeSessionEntry =
      params.activeSessionStore[params.sessionKey] ?? params.getActiveSessionEntry();
    if (!activeSessionEntry) {
      return;
    }
    if (!entryMatchesAutoFallbackPrimaryProbe(activeSessionEntry, probe)) {
      return;
    }
    clearAutoFallbackPrimaryProbeSelection(activeSessionEntry);
    params.activeSessionStore[params.sessionKey] = activeSessionEntry;
    if (!params.storePath) {
      return;
    }
    await updateSessionEntry(
      { storePath: params.storePath, sessionKey: params.sessionKey },
      (persistedEntry) => {
        if (!entryMatchesAutoFallbackPrimaryProbe(persistedEntry, probe)) {
          return null;
        }
        const shouldClearAuthProfile =
          persistedEntry.authProfileOverrideSource === "auto" ||
          (persistedEntry.authProfileOverrideSource === undefined &&
            persistedEntry.authProfileOverrideCompactionCount !== undefined);
        clearAutoFallbackPrimaryProbeSelection(persistedEntry);
        return {
          providerOverride: undefined,
          modelOverride: undefined,
          modelOverrideSource: undefined,
          modelOverrideFallbackOriginProvider: undefined,
          modelOverrideFallbackOriginModel: undefined,
          ...(shouldClearAuthProfile
            ? {
                authProfileOverride: undefined,
                authProfileOverrideSource: undefined,
                authProfileOverrideCompactionCount: undefined,
              }
            : {}),
          fallbackNoticeSelectedModel: undefined,
          fallbackNoticeActiveModel: undefined,
          fallbackNoticeReason: undefined,
          updatedAt: persistedEntry.updatedAt,
        };
      },
    );
  };

  while (true) {
    try {
      const normalizeStreamingText = (payload: ReplyPayload): { text?: string; skip: boolean } => {
        let text = payload.text;
        const reply = resolveSendableOutboundReplyParts(payload);
        if (params.followupRun.run.silentExpected) {
          return { skip: true };
        }
        if (!params.isHeartbeat && text?.includes("HEARTBEAT_OK")) {
          const stripped = stripHeartbeatToken(text, {
            mode: "message",
          });
          if (stripped.didStrip && !didLogHeartbeatStrip) {
            didLogHeartbeatStrip = true;
            logVerbose("Stripped stray HEARTBEAT_OK token from reply");
          }
          if (stripped.shouldSkip && !reply.hasMedia) {
            return { skip: true };
          }
          text = stripped.text;
        }
        if (isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
          return { skip: true };
        }
        if (
          isSilentReplyPrefixText(text, SILENT_REPLY_TOKEN) ||
          isSilentReplyPrefixText(text, HEARTBEAT_TOKEN)
        ) {
          return { skip: true };
        }
        if (text && startsWithSilentToken(text, SILENT_REPLY_TOKEN)) {
          text = stripLeadingSilentToken(text, SILENT_REPLY_TOKEN);
        }
        // Strip continuation markers (CONTINUE_WORK, [[CONTINUE_DELEGATE:…]])
        // from streamed blocks so they never reach the channel. The regex anchors
        // to the end of the text, so mid-sentence mentions are safe. Final-payload
        // stripping in runReplyAgent still runs for the assembled payloads.
        // Only strip when continuation is enabled — otherwise the tokens are
        // regular text the model happened to generate. (#104)
        if (
          text &&
          params.followupRun.run.config?.agents?.defaults?.continuation?.enabled === true
        ) {
          const cont = stripContinuationSignal(text);
          if (cont.signal) {
            text = cont.text;
          }
        }
        if (!text) {
          // Allow media-only payloads (e.g. tool result screenshots) through.
          if (reply.hasMedia) {
            return { text: undefined, skip: false };
          }
          return { skip: true };
        }
        const sanitized = sanitizeUserFacingText(text, {
          errorContext: Boolean(payload.isError),
        });
        if (!sanitized.trim()) {
          return { skip: true };
        }
        return { text: sanitized, skip: false };
      };
      const preparePartialForTyping = (payload: ReplyPayload): string | undefined => {
        if (isSilentReplyPrefixText(payload.text, SILENT_REPLY_TOKEN)) {
          return undefined;
        }
        const { text, skip } = normalizeStreamingText(payload);
        if (skip || !text) {
          return undefined;
        }
        return text;
      };
      const handlePartialForTyping = async (payload: ReplyPayload): Promise<string | undefined> => {
        const text = preparePartialForTyping(payload);
        if (text === undefined) {
          return undefined;
        }
        await params.typingSignals.signalTextDelta(text);
        return text;
      };
      const preserveProgressCallbackStartOrder =
        params.opts?.preserveProgressCallbackStartOrder === true;
      const startPresentationWhileTyping = async (
        typingPromise: Promise<void>,
        startPresentation: () => void | Promise<void>,
      ) => {
        let presentationPromise: void | Promise<void>;
        try {
          presentationPromise = startPresentation();
        } catch (err) {
          // Typing already started; observe a secondary failure if presentation throws inline.
          void typingPromise.catch(() => undefined);
          throw err;
        }
        await Promise.all([typingPromise, presentationPromise]);
      };
      const blockReplyPipeline = params.blockReplyPipeline;
      // Build the delivery handler once so both onAgentEvent (compaction start
      // notice) and the onBlockReply field share the same instance.  This
      // ensures replyToId threading (replyToMode=all|first) is applied to
      // compaction notices just like every other block reply.
      const blockReplyHandler = params.opts?.onBlockReply
        ? createBlockReplyDeliveryHandler({
            onBlockReply: params.opts.onBlockReply,
            currentMessageId: params.sessionCtx.MessageSidFull ?? params.sessionCtx.MessageSid,
            replyThreading: params.replyThreading,
            normalizeStreamingText,
            applyReplyToMode: params.applyReplyToMode,
            normalizeMediaPaths: replyMediaContext.normalizePayload,
            typingSignals: params.typingSignals,
            reasoningPayloadsEnabled: params.opts?.reasoningPayloadsEnabled,
            commentaryPayloadsEnabled: params.opts?.commentaryPayloadsEnabled,
            blockStreamingEnabled: params.blockStreamingEnabled,
            blockReplyPipeline,
            directlySentBlockKeys,
            directlySentBlockPayloads,
          })
        : undefined;
      let messageToolOnlyDeliveryCompleted = false;
      const messageToolOnlyDeliveryToolCallIds = new Set<string>();
      const sourceRepliesAreToolOnly =
        params.followupRun.run.sourceReplyDeliveryMode === "message_tool_only";
      const shouldSuppressProgressAfterMessageToolDelivery = () =>
        sourceRepliesAreToolOnly &&
        messageToolOnlyDeliveryCompleted &&
        params.opts?.allowProgressCallbacksWhenSourceDeliverySuppressed !== true;
      const onToolResult = params.opts?.onToolResult;
      const outcomePlan = buildAgentRuntimeOutcomePlan();
      const runLane = CommandLane.Main;
      let queuedUserMessagePersistedAcrossFallback = false;
      let assistantErrorPersistedAcrossFallback = false;
      const userTurnTranscriptRecorder =
        params.followupRun.userTurnTranscriptRecorder ?? params.opts?.userTurnTranscriptRecorder;
      const notifyUserMessagePersisted = () => {
        queuedUserMessagePersistedAcrossFallback = true;
      };
      const fastModeStartedAtMs = Date.now();
      const fastModeAutoProgressState: FastModeAutoProgressState = {
        offAnnounced: false,
        resetAnnounced: false,
      };
      const bootstrapContextRunKind: BootstrapContextRunKind =
        resolveHeartbeatRunScope(params.opts) === "commitment-only"
          ? "commitment-only"
          : params.isHeartbeat || params.opts?.isHeartbeat
            ? "heartbeat"
            : "default";
      const replyHookOptions =
        params.isHeartbeat && params.opts?.isHeartbeat !== true
          ? { ...params.opts, isHeartbeat: true }
          : params.opts;
      // Profiler-only milestone: it separates fallback setup from the actual
      // model run without adding extra live logs/snapshots to normal turns.
      agentTurnTiming.logMilestoneIfSlow({
        runId,
        sessionId: params.followupRun.run.sessionId,
        sessionKey: params.sessionKey,
        milestone: "before_model_fallback",
      });
      const fallbackResult = await agentTurnTiming.measure("model_fallback", () =>
        runWithModelFallback<
          | EmbeddedAgentRunResult
          | {
              result: EmbeddedAgentRunResult;
              continueWorkRequests?: ContinueWorkRequest[];
              compactionTraceparent?: string;
            }
        >({
          ...resolveModelFallbackOptions(effectiveRun, runtimeConfig),
          abortSignal: params.replyOperation?.abortSignal ?? params.opts?.abortSignal,
          runId,
          sessionId: params.followupRun.run.sessionId,
          lane: runLane,
          resolveAgentHarnessRuntimeOverride: (provider) =>
            resolveSessionRuntimeOverrideForProvider({
              provider,
              entry: liveModelSwitchRuntimeEntry ?? params.getActiveSessionEntry(),
              cfg: runtimeConfig,
            }),
          prepareAgentHarnessRuntime: async ({ provider, model, agentHarnessRuntimeOverride }) => {
            await agentTurnTiming.measure("fallback_prepare_harness", () =>
              ensureSelectedAgentHarnessPlugin({
                config: runtimeConfig,
                provider,
                modelId: model,
                agentId: params.followupRun.run.agentId,
                sessionKey: params.followupRun.run.runtimePolicySessionKey ?? params.sessionKey,
                agentHarnessRuntimeOverride,
                workspaceDir: params.followupRun.run.workspaceDir,
              }),
            );
          },
          onFallbackStep: (step) => {
            emitModelFallbackStepLifecycle({
              runId,
              sessionKey: params.sessionKey,
              step,
            });
          },
          classifyResult: async ({ result, provider, model }) => {
            const effectiveResult = isContinuationWrappedRunResult(result) ? result.result : result;
            const classification = outcomePlan.classifyRunResult({
              result: effectiveResult,
              provider,
              model,
              hasDirectlySentBlockReply: directlySentBlockKeys.size > 0,
              hasBlockReplyPipelineOutput: Boolean(
                blockReplyPipeline?.hasBuffered() || blockReplyPipeline?.didStream(),
              ),
            });
            if (classification) {
              await rollbackClassifiedFallbackCandidateSelection(provider, model);
            }
            return classification;
          },
          mergeExhaustedResult: (mergeParams) =>
            mergeEmbeddedAgentRunResultForModelFallbackExhaustion({
              latestResult: isContinuationWrappedRunResult(mergeParams.latestResult)
                ? mergeParams.latestResult.result
                : mergeParams.latestResult,
              preferredResult: isContinuationWrappedRunResult(mergeParams.preferredResult)
                ? mergeParams.preferredResult.result
                : mergeParams.preferredResult,
            }),
          run: async (provider, model, runOptions) => {
            attemptedRuntimeProvider = provider;
            attemptedRuntimeModel = model;
            const suppressQueuedUserPersistenceForCandidate =
              (params.followupRun.run.suppressNextUserMessagePersistence ?? false) ||
              queuedUserMessagePersistedAcrossFallback;
            const suppressAssistantErrorPersistenceForCandidate =
              assistantErrorPersistedAcrossFallback;
            const candidateRun = resolveRunForFallbackCandidate(provider, model);
            const candidateThinkLevel = resolveCandidateThinkingLevel({
              cfg: runtimeConfig,
              provider,
              modelId: model,
              level: params.followupRun.run.thinkLevel,
              agentId: params.followupRun.run.agentId,
              sessionKey: params.followupRun.run.runtimePolicySessionKey ?? params.sessionKey,
              sessionEntry: params.getActiveSessionEntry(),
            });
            const candidateFastMode = resolveRunFastModeForFallbackCandidate({
              run: candidateRun,
              config: runtimeConfig,
              provider,
              model,
              sessionEntry: params.getActiveSessionEntry(),
            });
            const activeProbe = effectiveRun.autoFallbackPrimaryProbe;
            if (activeProbe && provider === activeProbe.provider && model === activeProbe.model) {
              markAutoFallbackPrimaryProbe({
                probe: activeProbe,
                sessionKey: params.sessionKey,
              });
            }
            // Notify that model selection is complete (including after fallback).
            // This allows responsePrefix template interpolation with the actual model.
            params.opts?.onModelSelected?.({
              provider,
              model,
              thinkLevel: candidateThinkLevel,
            });
            let rollbackFallbackCandidateSelection: (() => Promise<void>) | undefined;
            try {
              rollbackFallbackCandidateSelection = await agentTurnTiming.measure(
                "fallback_persist_selection",
                () => persistFallbackCandidateSelection(provider, model, candidateRun),
              );
              if (rollbackFallbackCandidateSelection) {
                pendingFallbackCandidateRollback = {
                  provider,
                  model,
                  rollback: rollbackFallbackCandidateSelection,
                };
              }
            } catch (error) {
              logVerbose(
                `failed to persist fallback candidate selection (non-fatal): ${String(error)}`,
              );
            }
            const { sessionRuntimeOverride, cliExecutionProvider, useCliExecution } =
              agentTurnTiming.measureSync("fallback_resolve_runtime", () => {
                const activeSessionEntry =
                  liveModelSwitchRuntimeEntry ?? params.getActiveSessionEntry();
                const resolvedSessionRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
                  provider,
                  entry: activeSessionEntry,
                  cfg: runtimeConfig,
                });
                // A locked harness owns the transcript. A configured CLI backend with the
                // same id must not steal dispatch from that persisted harness.
                const locksPersistedHarness =
                  activeSessionEntry?.modelSelectionLocked === true &&
                  normalizeLowercaseStringOrEmpty(activeSessionEntry.agentHarnessId) ===
                    resolvedSessionRuntimeOverride;
                const resolvedSelectedAuthProfile = resolveRunAuthProfile(candidateRun, provider, {
                  config: runtimeConfig,
                });
                const pinnedCliRuntime =
                  !locksPersistedHarness &&
                  resolvedSessionRuntimeOverride &&
                  isCliProvider(resolvedSessionRuntimeOverride, runtimeConfig)
                    ? resolvedSessionRuntimeOverride
                    : undefined;
                const resolvedCliExecutionProvider =
                  pinnedCliRuntime ??
                  (resolvedSessionRuntimeOverride
                    ? provider
                    : (resolveCliRuntimeExecutionProvider({
                        provider,
                        cfg: runtimeConfig,
                        agentId: params.followupRun.run.agentId,
                        modelId: model,
                        authProfileId: resolvedSelectedAuthProfile.authProfileId,
                      }) ?? provider));
                return {
                  sessionRuntimeOverride: resolvedSessionRuntimeOverride,
                  cliExecutionProvider: resolvedCliExecutionProvider,
                  useCliExecution:
                    pinnedCliRuntime !== undefined ||
                    (!resolvedSessionRuntimeOverride &&
                      isCliProvider(resolvedCliExecutionProvider, runtimeConfig)),
                };
              });

            if (useCliExecution) {
              const cliSessionBinding = getCliSessionBinding(
                params.getActiveSessionEntry(),
                cliExecutionProvider,
              );
              const cliLifecycleStartedAt = Date.now();
              const lifecycleBackstop = createAgentLifecycleTerminalBackstop({
                runId,
                sessionKey: params.sessionKey,
                startedAt: cliLifecycleStartedAt,
                getLifecycleGeneration: () => lifecycleGeneration,
                resolveTerminationFields: (error) => ({
                  ...resolveAgentRunErrorLifecycleFields(error, runAbortSignal),
                  ...(isReplyOperationRestartAbort(params.replyOperation)
                    ? {
                        aborted: true as const,
                        stopReason: AGENT_RUN_RESTART_ABORT_STOP_REASON,
                      }
                    : {}),
                }),
              });
              pendingLifecycleTerminal = { provider, model, backstop: lifecycleBackstop };
              const authProfile = resolveRunAuthProfile(candidateRun, cliExecutionProvider, {
                config: runtimeConfig,
              });
              let droppedCliSessionReplacement = false;
              const hookMessageProvider = resolveOriginMessageProvider({
                originatingChannel: params.followupRun.originatingChannel,
                provider: params.sessionCtx.Provider,
              });
              const cliCurrentThreadId =
                params.followupRun.originatingThreadId ?? params.sessionCtx.MessageThreadId;
              const isRestartSentinelContinuation =
                params.sessionCtx.InputProvenance?.kind === "internal_system" &&
                params.sessionCtx.InputProvenance.sourceTool === "restart-sentinel";
              const cliCurrentMessageId = isRestartSentinelContinuation
                ? params.sessionCtx.ReplyToId
                : (params.sessionCtx.MessageSidFull ?? params.sessionCtx.MessageSid);
              const cliToolSummaryTracker = createCliToolSummaryTracker({
                detailMode: params.toolProgressDetail,
                shouldEmitToolResult: params.shouldEmitToolResult,
                shouldEmitToolOutput: params.shouldEmitToolOutput,
                deliver: async (payload) => {
                  await params.opts?.onToolResult?.(payload);
                },
              });
              const result = await agentTurnTiming.measure("cli_run", () =>
                runCliAgentWithLifecycle({
                  runId,
                  lifecycleGeneration,
                  provider: cliExecutionProvider,
                  startedAt: cliLifecycleStartedAt,
                  emitLifecycleTerminal: false,
                  onAgentRunStart: notifyAgentRunStart,
                  suppressAssistantBridge: params.followupRun.run.silentExpected,
                  onActivity: () => params.replyOperation?.recordActivity(),
                  preserveProgressCallbackStartOrder,
                  onAssistantText: async (text) => {
                    if (!preserveProgressCallbackStartOrder) {
                      const textForTyping = await handlePartialForTyping({
                        text,
                      } as ReplyPayload);
                      if (textForTyping === undefined || !params.opts?.onPartialReply) {
                        return;
                      }
                      await params.opts.onPartialReply({ text: textForTyping });
                      return;
                    }
                    const textForTyping = preparePartialForTyping({ text } as ReplyPayload);
                    if (textForTyping === undefined) {
                      return;
                    }
                    // Assistant and tool CLI bridges drain independently; stage presentation
                    // before typing I/O so a later tool cannot overtake this text.
                    await startPresentationWhileTyping(
                      params.typingSignals.signalTextDelta(textForTyping),
                      () => params.opts?.onPartialReply?.({ text: textForTyping }),
                    );
                  },
                  onReasoningText: createCliReasoningStreamBridge(params.opts?.onReasoningStream),
                  onReasoningProgress: async (payload) => {
                    await params.opts?.onReasoningProgress?.(payload);
                  },
                  onToolEvent: async (payload) => {
                    if (!preserveProgressCallbackStartOrder) {
                      await cliToolSummaryTracker.noteToolEvent(payload);
                      if (payload.phase === "result") {
                        return;
                      }
                      const { name, phase, args } = payload;
                      await Promise.all([
                        params.typingSignals.signalToolStart(),
                        params.opts?.onToolStart?.({
                          name,
                          phase,
                          args,
                          detailMode: params.toolProgressDetail,
                        }),
                      ]);
                      return;
                    }
                    const summaryPromise = cliToolSummaryTracker.noteToolEvent(payload);
                    if (payload.phase === "result") {
                      await summaryPromise;
                      return;
                    }
                    const { name, phase, args } = payload;
                    // Tool and assistant CLI bridges drain independently. Start channel
                    // presentation before either bridge can yield and invert source order.
                    await Promise.all([
                      summaryPromise,
                      startPresentationWhileTyping(params.typingSignals.signalToolStart(), () =>
                        params.opts?.onToolStart?.({
                          name,
                          phase,
                          args,
                          detailMode: params.toolProgressDetail,
                        }),
                      ),
                    ]);
                  },
                  onCommentaryText:
                    params.opts?.commentaryProgressEnabled === true && params.opts.onItemEvent
                      ? async (payload) => {
                          await params.opts?.onItemEvent?.({
                            itemId: payload.itemId,
                            kind: "preamble",
                            progressText: payload.text,
                          });
                        }
                      : undefined,
                  onFastModeAutoProgress: async (payload) => {
                    await params.opts?.onToolResult?.(payload);
                  },
                  transformResult:
                    params.followupRun.currentInboundEventKind === "room_event"
                      ? (resultLocal) =>
                          keepCliSessionBindingOnlyWhenReused({
                            result: resultLocal,
                            existingSessionId: cliSessionBinding?.sessionId,
                            onDroppedReplacement: () => {
                              droppedCliSessionReplacement = true;
                            },
                          })
                      : undefined,
                  runParams: {
                    sessionId: params.followupRun.run.sessionId,
                    sessionKey: params.sessionKey,
                    runtimePolicySessionKey:
                      params.followupRun.run.runtimePolicySessionKey ??
                      params.runtimePolicySessionKey,
                    agentId: params.followupRun.run.agentId,
                    trigger: resolveReplyHookTrigger(replyHookOptions),
                    sessionFile: params.followupRun.run.sessionFile,
                    workspaceDir: params.followupRun.run.workspaceDir,
                    cwd: params.followupRun.run.cwd,
                    config: runtimeConfig,
                    prompt: params.commandBody,
                    transcriptPrompt: params.transcriptCommandBody,
                    suppressNextUserMessagePersistence: suppressQueuedUserPersistenceForCandidate,
                    userTurnTranscriptRecorder,
                    onUserMessagePersisted: notifyUserMessagePersisted,
                    persistAssistantTranscript:
                      params.followupRun.currentInboundEventKind !== "room_event" &&
                      params.followupRun.run.suppressTranscriptOnlyAssistantPersistence !== true,
                    storePath: params.storePath,
                    currentInboundEventKind: params.followupRun.currentInboundEventKind,
                    currentInboundContext: params.followupRun.currentInboundContext,
                    inputProvenance: params.followupRun.run.inputProvenance,
                    modelProvider: provider,
                    provider: cliExecutionProvider,
                    execOverrides: params.followupRun.run.execOverrides,
                    bashElevated: params.followupRun.run.bashElevated,
                    model,
                    thinkLevel: candidateThinkLevel,
                    fastMode: candidateFastMode.fastMode,
                    fastModeStartedAtMs,
                    fastModeAutoOnSeconds: candidateFastMode.fastModeAutoOnSeconds,
                    fastModeAutoProgressState,
                    isFinalFallbackAttempt: runOptions?.isFinalFallbackAttempt,
                    timeoutMs: params.followupRun.run.timeoutMs,
                    runTimeoutOverrideMs: params.followupRun.run.runTimeoutOverrideMs,
                    runId,
                    lane: runLane,
                    extraSystemPrompt: params.followupRun.run.extraSystemPrompt,
                    sourceReplyDeliveryMode: params.followupRun.run.sourceReplyDeliveryMode,
                    taskSuggestionDeliveryMode: params.followupRun.run.taskSuggestionDeliveryMode,
                    silentReplyPromptMode: params.followupRun.run.silentReplyPromptMode,
                    allowEmptyAssistantReplyAsSilent:
                      params.followupRun.run.allowEmptyAssistantReplyAsSilent,
                    extraSystemPromptStatic: params.followupRun.run.extraSystemPromptStatic,
                    cliSessionBindingFacts: params.followupRun.run.cliSessionBindingFacts,
                    ownerNumbers: params.followupRun.run.ownerNumbers,
                    cliSessionId: cliSessionBinding?.sessionId,
                    cliSessionBinding,
                    authProfileId: authProfile.authProfileId,
                    bootstrapContextMode: params.opts?.bootstrapContextMode,
                    bootstrapContextRunKind,
                    bootstrapPromptWarningSignaturesSeen,
                    bootstrapPromptWarningSignature:
                      bootstrapPromptWarningSignaturesSeen[
                        bootstrapPromptWarningSignaturesSeen.length - 1
                      ],
                    images: currentTurnImages.images,
                    imageOrder: currentTurnImages.imageOrder,
                    skillsSnapshot: params.followupRun.run.skillsSnapshot,
                    messageChannel: params.followupRun.originatingChannel ?? undefined,
                    messageProvider: hookMessageProvider,
                    clientCaps: params.followupRun.run.clientCaps,
                    currentChannelId:
                      params.followupRun.originatingTo ??
                      params.sessionCtx.OriginatingTo ??
                      params.sessionCtx.To,
                    senderId: params.followupRun.run.senderId,
                    senderName: params.followupRun.run.senderName,
                    senderUsername: params.followupRun.run.senderUsername,
                    senderE164: params.followupRun.run.senderE164,
                    groupId: params.followupRun.run.groupId,
                    groupChannel: params.followupRun.run.groupChannel,
                    groupSpace: params.followupRun.run.groupSpace,
                    spawnedBy: params.followupRun.run.spawnedBy,
                    chatId: params.followupRun.originatingChatId,
                    channelContext: params.followupRun.run.channelContext,
                    currentThreadTs:
                      cliCurrentThreadId != null ? String(cliCurrentThreadId) : undefined,
                    currentMessageId: cliCurrentMessageId,
                    currentInboundAudio: hasInboundAudio(params.sessionCtx),
                    agentAccountId: params.followupRun.run.agentAccountId,
                    senderIsOwner: params.followupRun.run.senderIsOwner,
                    approvalReviewerDeviceId: params.followupRun.run.approvalReviewerDeviceId,
                    toolsAllow: params.opts?.toolsAllow,
                    disableTools: params.opts?.disableTools,
                    abortSignal: runAbortSignal,
                    onExecutionPhase: signalExecutionPhaseForTyping,
                    replyOperation: params.replyOperation,
                  },
                }),
              );
              if (droppedCliSessionReplacement) {
                await clearDroppedCliSessionBinding({
                  provider: cliExecutionProvider,
                  sessionKey: params.sessionKey,
                  sessionStore: params.activeSessionStore,
                  storePath: params.storePath,
                  activeSessionEntry: params.getActiveSessionEntry(),
                });
              }
              bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
                result.meta?.systemPromptReport,
              );
              return result;
            }
            const { embeddedContext, senderContext, runBaseParams } =
              buildEmbeddedRunExecutionParams({
                run: { ...candidateRun, ...candidateFastMode, thinkLevel: candidateThinkLevel },
                replyRoute: params.followupRun,
                sessionCtx: params.sessionCtx,
                hasRepliedRef: params.opts?.hasRepliedRef,
                provider,
                runId,
                promptCacheKey: params.opts?.promptCacheKey,
                allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
                model,
              });
            const agentHarnessPolicy = sessionRuntimeOverride
              ? ({ runtime: sessionRuntimeOverride, runtimeSource: "model" } as const)
              : resolveAgentHarnessPolicy({
                  provider,
                  modelId: model,
                  config: runtimeConfig,
                  agentId: params.followupRun.run.agentId,
                  sessionKey: params.followupRun.run.runtimePolicySessionKey ?? params.sessionKey,
                });
            const embeddedRunProvider = resolveOpenAIRuntimeProvider({
              provider,
              harnessRuntime: agentHarnessPolicy.runtime,
              authProfileProvider: runBaseParams.authProfileId?.split(":", 1)[0],
              authProfileId: runBaseParams.authProfileId,
              config: runtimeConfig,
              workspaceDir: params.followupRun.run.workspaceDir,
            });
            const embeddedRunHarnessOverride =
              sessionRuntimeOverride ??
              (agentHarnessPolicy.runtime === "openclaw" && embeddedRunProvider !== provider
                ? "openclaw"
                : undefined);
            const messageActionCapabilitySessionKey =
              params.runtimePolicySessionKey ?? embeddedContext.sessionKey;
            const messageActionTurnCapability =
              isTrustedMessageActionTurnIngress(params.sessionCtx.Provider) &&
              !params.isHeartbeat &&
              embeddedContext.agentId &&
              messageActionCapabilitySessionKey &&
              embeddedContext.messageProvider &&
              embeddedContext.currentChannelId
                ? mintMessageActionTurnCapability({
                    agentId: embeddedContext.agentId,
                    runId,
                    sessionKey: messageActionCapabilitySessionKey,
                    sessionId: embeddedContext.sessionId,
                    requesterAccountId: embeddedContext.agentAccountId,
                    requesterSenderId: senderContext.senderId,
                    toolContext: {
                      currentChannelId: embeddedContext.currentChannelId,
                      currentChatType: embeddedContext.chatType,
                      currentMessagingTarget: embeddedContext.currentMessagingTarget,
                      currentGraphChannelId: embeddedContext.currentGraphChannelId,
                      currentChannelProvider: embeddedContext.currentChannelProvider,
                      currentThreadTs: embeddedContext.currentThreadTs,
                      currentMessageId: embeddedContext.currentMessageId,
                      replyToMode: embeddedContext.replyToMode,
                      hasRepliedRef: embeddedContext.hasRepliedRef,
                      sameChannelThreadRequired: embeddedContext.sameChannelThreadRequired,
                    },
                    ttlMs: runBaseParams.timeoutMs + 60_000,
                  })
                : undefined;
            return (async () => {
              let attemptCompactionCount = 0;
              let attemptCompactionTraceparent: string | undefined;
              // Accumulate every continue_work election fired this turn. A single
              // model response can emit N calls; capturing only the last one
              // silently drops the rest (#982).
              const attemptContinueWorkRequests: ContinueWorkRequest[] = [];
              const lifecycleBackstop = createAgentLifecycleTerminalBackstop({
                runId,
                sessionKey: params.sessionKey,
                getLifecycleGeneration: () => lifecycleGeneration,
                resolveTerminationFields: (error) => ({
                  ...resolveAgentRunErrorLifecycleFields(error, runAbortSignal),
                  ...(isReplyOperationRestartAbort(params.replyOperation)
                    ? {
                        aborted: true as const,
                        stopReason: AGENT_RUN_RESTART_ABORT_STOP_REASON,
                      }
                    : {}),
                }),
              });
              pendingLifecycleTerminal = { provider, model, backstop: lifecycleBackstop };
              try {
                // Profiler-only milestone: it exposes time spent before Codex
                // dispatch while leaving the regular embedded run path inert.
                agentTurnTiming.logMilestoneIfSlow({
                  runId,
                  sessionId: params.followupRun.run.sessionId,
                  sessionKey: params.sessionKey,
                  milestone: "before_embedded_run",
                });
                const embeddedRunResult = await agentTurnTiming.measure("embedded_run", () =>
                  runEmbeddedAgent({
                    ...embeddedContext,
                    messageActionTurnCapability,
                    lifecycleGeneration,
                    allowGatewaySubagentBinding: true,
                    trigger: resolveReplyHookTrigger(replyHookOptions),
                    fireReason: resolveReplyRunFireReason({
                      opts: replyHookOptions,
                      drainsContinuationDelegateQueue:
                        effectiveRun.drainsContinuationDelegateQueue === true,
                    }),
                    parentRunId: params.opts?.parentRunId,
                    lane: params.opts?.lane,
                    groupId: resolveGroupSessionKey(params.sessionCtx)?.id,
                    groupChannel:
                      normalizeOptionalString(params.sessionCtx.GroupChannel) ??
                      normalizeOptionalString(params.sessionCtx.GroupSubject),
                    groupSpace: normalizeOptionalString(params.sessionCtx.GroupSpace),
                    ...senderContext,
                    ...runBaseParams,
                    provider: embeddedRunProvider,
                    agentHarnessId: embeddedRunHarnessOverride,
                    agentHarnessRuntimeOverride: embeddedRunHarnessOverride,
                    fastModeStartedAtMs,
                    fastModeAutoProgressState,
                    isFinalFallbackAttempt: runOptions?.isFinalFallbackAttempt,
                    sandboxSessionKey: params.runtimePolicySessionKey,
                    prompt: params.commandBody,
                    transcriptPrompt: params.transcriptCommandBody,
                    userTurnTranscriptRecorder,
                    currentInboundEventKind: params.followupRun.currentInboundEventKind,
                    currentInboundContext: params.followupRun.currentInboundContext,
                    extraSystemPrompt: params.followupRun.run.extraSystemPrompt,
                    sourceReplyDeliveryMode: params.followupRun.run.sourceReplyDeliveryMode,
                    forceMessageTool:
                      params.followupRun.run.sourceReplyDeliveryMode === "message_tool_only",
                    silentReplyPromptMode: params.followupRun.run.silentReplyPromptMode,
                    suppressNextUserMessagePersistence: suppressQueuedUserPersistenceForCandidate,
                    onUserMessagePersisted: notifyUserMessagePersisted,
                    suppressTranscriptOnlyAssistantPersistence:
                      params.followupRun.run.suppressTranscriptOnlyAssistantPersistence,
                    suppressAssistantErrorPersistence:
                      suppressAssistantErrorPersistenceForCandidate,
                    onAssistantErrorMessagePersisted: () => {
                      assistantErrorPersistedAcrossFallback = true;
                    },
                    drainsContinuationDelegateQueue:
                      params.followupRun.run.drainsContinuationDelegateQueue,
                    // Read from runtimeConfig (live snapshot) for source-consistency
                    // with requestCompactionOpts below. Previously read from
                    // params.followupRun.run.config (queue-time snapshot), which can
                    // diverge from runtimeConfig when config hot-reloads between
                    // queue-time and execution-time via resolveQueuedReplyRuntimeConfig
                    // → selectApplicableRuntimeConfig. Asymmetric source-reads were
                    // producing asymmetric undefined-vs-defined opts and tripping the
                    // continuation-misconfig-warn guard at openclaw-tools.ts:624 on
                    // the path where one source resolved enabled=true and the other
                    // resolved enabled=false. Identified during code review.
                    continueWorkOpts:
                      runtimeConfig?.agents?.defaults?.continuation?.enabled === true
                        ? {
                            requestContinuation: (request) => {
                              attemptContinueWorkRequests.push(request);
                            },
                          }
                        : undefined,
                    toolResultFormat: (() => {
                      const channel = resolveMessageChannel(
                        params.sessionCtx.Surface,
                        params.sessionCtx.Provider,
                      );
                      if (!channel) {
                        return "markdown";
                      }
                      return isMarkdownCapableMessageChannel(channel) ? "markdown" : "plain";
                    })(),
                    toolProgressDetail: params.toolProgressDetail,
                    suppressToolErrorWarnings:
                      params.opts?.shouldSuppressToolErrorWarnings ??
                      params.opts?.suppressToolErrorWarnings,
                    toolsAllow: params.opts?.toolsAllow,
                    disableTools: params.opts?.disableTools,
                    enableHeartbeatTool: params.opts?.enableHeartbeatTool,
                    forceHeartbeatTool: params.opts?.forceHeartbeatTool,
                    bootstrapContextMode: params.opts?.bootstrapContextMode,
                    bootstrapContextRunKind,
                    images: currentTurnImages.images,
                    imageOrder: currentTurnImages.imageOrder,
                    abortSignal: params.replyOperation?.abortSignal ?? params.opts?.abortSignal,
                    replyOperation: params.replyOperation,
                    requestCompactionOpts:
                      runtimeConfig?.agents?.defaults?.continuation?.enabled === true
                        ? {
                            sessionId: params.followupRun.run.sessionId,
                            getContextUsage: () =>
                              computeRequestCompactionContextUsage({
                                entry: params.getActiveSessionEntry(),
                                cfg: params.followupRun.run.config,
                                provider,
                                model,
                              }),
                            triggerCompaction: async (request) => {
                              attemptCompactionTraceparent = request.traceparent;
                              try {
                                const { compactEmbeddedAgentSession } =
                                  await import("../../agents/embedded-agent-runner/compact.queued.js");
                                const compactionAuthProfileId =
                                  provider === params.followupRun.run.provider
                                    ? params.followupRun.run.authProfileId
                                    : undefined;
                                const result = await compactEmbeddedAgentSession({
                                  sessionId: params.followupRun.run.sessionId ?? "",
                                  runId: request.runId ?? runId,
                                  sessionKey: params.sessionKey,
                                  sessionFile: params.followupRun.run.sessionFile ?? "",
                                  workspaceDir:
                                    params.followupRun.run.workspaceDir ?? process.cwd(),
                                  config: params.followupRun.run.config,
                                  messageProvider: params.followupRun.run.messageProvider,
                                  provider,
                                  model,
                                  authProfileId: compactionAuthProfileId,
                                  customInstructions: request.customInstructions,
                                  trigger: request.trigger,
                                  diagId: request.diagId,
                                  traceparent: request.traceparent,
                                });
                                if (result.ok && result.compacted) {
                                  await releaseQueuedCompactionTolerant({
                                    activeSessionStore: params.activeSessionStore,
                                    compactionResult: result,
                                    followupRun: params.followupRun,
                                    getActiveSessionEntry: params.getActiveSessionEntry,
                                    sessionKey: params.sessionKey,
                                    storePath: params.storePath,
                                    traceparent: request.traceparent,
                                  });
                                }
                                return {
                                  ok: result.ok,
                                  compacted: result.compacted,
                                  reason: result.reason,
                                };
                              } catch (err) {
                                return {
                                  ok: false,
                                  compacted: false,
                                  reason: err instanceof Error ? err.message : String(err),
                                };
                              }
                            },
                          }
                        : undefined,
                    deferTerminalLifecycle: true,
                    onExecutionStarted: (info) => {
                      if (info?.lifecycleGeneration) {
                        lifecycleGeneration = info.lifecycleGeneration;
                      }
                    },
                    onExecutionPhase: signalExecutionPhaseForTyping,
                    blockReplyBreak: params.resolvedBlockStreamingBreak,
                    blockReplyChunking: params.blockReplyChunking,
                    // Subscriber callbacks are detached. Start channel presentation before
                    // awaiting typing so later source events cannot overtake state staging.
                    onPartialReply: async (payload) => {
                      if (!preserveProgressCallbackStartOrder) {
                        const textForTyping = await handlePartialForTyping(payload);
                        if (!params.opts?.onPartialReply || textForTyping === undefined) {
                          return;
                        }
                        await params.opts.onPartialReply({
                          text: textForTyping,
                          mediaUrls: payload.mediaUrls,
                        });
                        return;
                      }
                      const textForTyping = preparePartialForTyping(payload);
                      if (textForTyping === undefined) {
                        return;
                      }
                      await startPresentationWhileTyping(
                        params.typingSignals.signalTextDelta(textForTyping),
                        () =>
                          params.opts?.onPartialReply?.({
                            text: textForTyping,
                            mediaUrls: payload.mediaUrls,
                          }),
                      );
                    },
                    onAssistantMessageStart: async () => {
                      if (!preserveProgressCallbackStartOrder) {
                        await params.typingSignals.signalMessageStart();
                        await params.opts?.onAssistantMessageStart?.();
                        return;
                      }
                      await startPresentationWhileTyping(
                        params.typingSignals.signalMessageStart(),
                        () => params.opts?.onAssistantMessageStart?.(),
                      );
                    },
                    onReasoningStream:
                      params.typingSignals.shouldStartOnReasoning || params.opts?.onReasoningStream
                        ? async (payload) => {
                            if (params.followupRun.run.silentExpected) {
                              return;
                            }
                            if (!preserveProgressCallbackStartOrder) {
                              await params.typingSignals.signalReasoningDelta();
                              await params.opts?.onReasoningStream?.({
                                text: payload.text,
                                mediaUrls: payload.mediaUrls,
                                isReasoningSnapshot: payload.isReasoningSnapshot,
                                requiresReasoningProgressOptIn:
                                  payload.requiresReasoningProgressOptIn,
                              });
                              return;
                            }
                            await startPresentationWhileTyping(
                              params.typingSignals.signalReasoningDelta(),
                              () =>
                                params.opts?.onReasoningStream?.({
                                  text: payload.text,
                                  mediaUrls: payload.mediaUrls,
                                  isReasoningSnapshot: payload.isReasoningSnapshot,
                                  requiresReasoningProgressOptIn:
                                    payload.requiresReasoningProgressOptIn,
                                }),
                            );
                          }
                        : undefined,
                    streamReasoningInNonStreamModes: params.opts?.streamReasoningInNonStreamModes,
                    onReasoningEnd: params.opts?.onReasoningEnd,
                    onAgentEvent: (() => {
                      // Normalize commentary deltas/snapshots into full preamble text.
                      const commentaryTextByItem = new Map<string, string>();
                      const lastEmittedCommentaryByItem = new Map<string, string>();
                      return async (evt) => {
                        params.replyOperation?.recordActivity();
                        lifecycleBackstop.note(evt);
                        // Signal run start only after the embedded agent emits real activity.
                        const hasLifecyclePhase =
                          evt.stream === "lifecycle" && typeof evt.data.phase === "string";
                        if (evt.stream !== "lifecycle" || hasLifecyclePhase) {
                          notifyAgentRunStart();
                        }
                        if (
                          evt.stream === "lifecycle" &&
                          readStringValue(evt.data.livenessState) === "blocked"
                        ) {
                          await surfaceBlockedLivenessState();
                        }
                        // Trigger typing when tools start executing.
                        // Must await to ensure typing indicator starts before tool summaries are emitted.
                        if (evt.stream === "tool" && evt.data.hideFromChannelProgress !== true) {
                          const phase = readStringValue(evt.data.phase) ?? "";
                          const name = readStringValue(evt.data.name);
                          const toolCallId = readStringValue(evt.data.toolCallId) ?? "";
                          const args =
                            evt.data.args && typeof evt.data.args === "object"
                              ? (evt.data.args as Record<string, unknown>)
                              : undefined;
                          if (
                            sourceRepliesAreToolOnly &&
                            toolCallId &&
                            name &&
                            (phase === "start" || phase === "update") &&
                            args &&
                            isMessagingToolSendAction(name, args)
                          ) {
                            messageToolOnlyDeliveryToolCallIds.add(toolCallId);
                          }
                          if (shouldSuppressProgressAfterMessageToolDelivery()) {
                            return;
                          }
                          if (phase === "start" || phase === "update") {
                            const toolStartProgressPromise = params.opts?.onToolStart?.({
                              itemId: readStringValue(evt.data.itemId),
                              toolCallId: readStringValue(evt.data.toolCallId),
                              name,
                              phase,
                              args,
                              detailMode: params.toolProgressDetail,
                            });
                            await Promise.all([
                              params.typingSignals.signalToolStart(),
                              toolStartProgressPromise,
                            ]);
                          }
                          const commandOutput = buildCommandOutputFromToolResultEvent(evt);
                          if (commandOutput) {
                            await params.opts?.onCommandOutput?.(commandOutput);
                          }
                        }
                        const suppressItemChannelProgress =
                          evt.stream === "item" &&
                          evt.data.suppressChannelProgress === true &&
                          Boolean(params.opts?.onToolStart);
                        const hideItemFromChannelProgress =
                          evt.stream === "item" && evt.data.hideFromChannelProgress === true;
                        const itemPhase =
                          evt.stream === "item" ? readStringValue(evt.data.phase) : "";
                        const itemName =
                          evt.stream === "item" ? readStringValue(evt.data.name) : "";
                        const itemStatus =
                          evt.stream === "item" ? readStringValue(evt.data.status) : "";
                        const itemToolCallId =
                          evt.stream === "item" ? (readStringValue(evt.data.toolCallId) ?? "") : "";
                        const completedMessageToolDelivery =
                          sourceRepliesAreToolOnly &&
                          itemPhase === "end" &&
                          itemStatus === "completed" &&
                          itemToolCallId.length > 0 &&
                          messageToolOnlyDeliveryToolCallIds.has(itemToolCallId);
                        const suppressProgressAfterMessageToolDelivery =
                          shouldSuppressProgressAfterMessageToolDelivery();
                        if (completedMessageToolDelivery) {
                          messageToolOnlyDeliveryToolCallIds.delete(itemToolCallId);
                          messageToolOnlyDeliveryCompleted = true;
                        }
                        if (
                          evt.stream === "assistant" &&
                          readStringValue(evt.data.phase) === "commentary" &&
                          !shouldSuppressProgressAfterMessageToolDelivery()
                        ) {
                          const commentaryItemId = readStringValue(evt.data.itemId) ?? "";
                          const snapshotText = readStringValue(evt.data.text);
                          const deltaText = readStringValue(evt.data.delta);
                          const accumulated =
                            evt.data.replace === true && snapshotText
                              ? snapshotText
                              : deltaText
                                ? `${commentaryTextByItem.get(commentaryItemId) ?? ""}${deltaText}`
                                : (snapshotText ?? "");
                          commentaryTextByItem.set(commentaryItemId, accumulated);
                          const commentaryText = accumulated.replace(/\s+/g, " ").trim();
                          if (
                            commentaryText &&
                            lastEmittedCommentaryByItem.get(commentaryItemId) !== commentaryText
                          ) {
                            lastEmittedCommentaryByItem.set(commentaryItemId, commentaryText);
                            await params.opts?.onItemEvent?.({
                              itemId: commentaryItemId || undefined,
                              kind: "preamble",
                              title: "Preamble",
                              phase: "update",
                              progressText: commentaryText,
                            });
                          }
                        }
                        if (
                          evt.stream === "item" &&
                          !hideItemFromChannelProgress &&
                          !suppressItemChannelProgress &&
                          (!suppressProgressAfterMessageToolDelivery ||
                            completedMessageToolDelivery)
                        ) {
                          await params.opts?.onItemEvent?.({
                            itemId: readStringValue(evt.data.itemId),
                            toolCallId: readStringValue(evt.data.toolCallId),
                            kind: readStringValue(evt.data.kind),
                            title: readStringValue(evt.data.title),
                            name: itemName,
                            phase: itemPhase,
                            status: itemStatus,
                            summary: readStringValue(evt.data.summary),
                            progressText: readStringValue(evt.data.progressText),
                            meta: readStringValue(evt.data.meta),
                            approvalId: readStringValue(evt.data.approvalId),
                            approvalSlug: readStringValue(evt.data.approvalSlug),
                          });
                        }
                        if (
                          evt.stream === "plan" &&
                          !shouldSuppressProgressAfterMessageToolDelivery()
                        ) {
                          await params.opts?.onPlanUpdate?.({
                            phase: readStringValue(evt.data.phase),
                            title: readStringValue(evt.data.title),
                            explanation: readStringValue(evt.data.explanation),
                            steps: Array.isArray(evt.data.steps)
                              ? evt.data.steps.filter(
                                  (step): step is string => typeof step === "string",
                                )
                              : undefined,
                            source: readStringValue(evt.data.source),
                          });
                        }
                        if (
                          evt.stream === "approval" &&
                          !shouldSuppressProgressAfterMessageToolDelivery()
                        ) {
                          await params.opts?.onApprovalEvent?.({
                            phase: readStringValue(evt.data.phase),
                            kind: readStringValue(evt.data.kind),
                            status: readStringValue(evt.data.status),
                            title: readStringValue(evt.data.title),
                            itemId: readStringValue(evt.data.itemId),
                            toolCallId: readStringValue(evt.data.toolCallId),
                            approvalId: readStringValue(evt.data.approvalId),
                            approvalSlug: readStringValue(evt.data.approvalSlug),
                            command: readStringValue(evt.data.command),
                            host: readStringValue(evt.data.host),
                            reason: readStringValue(evt.data.reason),
                            scope: readApprovalScopeValue(evt.data.scope),
                            message: readStringValue(evt.data.message),
                          });
                        }
                        if (
                          evt.stream === "command_output" &&
                          !shouldSuppressProgressAfterMessageToolDelivery()
                        ) {
                          await params.opts?.onCommandOutput?.({
                            itemId: readStringValue(evt.data.itemId),
                            phase: readStringValue(evt.data.phase),
                            title: readStringValue(evt.data.title),
                            toolCallId: readStringValue(evt.data.toolCallId),
                            name: readStringValue(evt.data.name),
                            output: readStringValue(evt.data.output),
                            status: readStringValue(evt.data.status),
                            exitCode:
                              typeof evt.data.exitCode === "number" || evt.data.exitCode === null
                                ? evt.data.exitCode
                                : undefined,
                            durationMs:
                              typeof evt.data.durationMs === "number"
                                ? evt.data.durationMs
                                : undefined,
                            cwd: readStringValue(evt.data.cwd),
                          });
                        }
                        if (
                          evt.stream === "patch" &&
                          !shouldSuppressProgressAfterMessageToolDelivery()
                        ) {
                          await params.opts?.onPatchSummary?.({
                            itemId: readStringValue(evt.data.itemId),
                            phase: readStringValue(evt.data.phase),
                            title: readStringValue(evt.data.title),
                            toolCallId: readStringValue(evt.data.toolCallId),
                            name: readStringValue(evt.data.name),
                            added: Array.isArray(evt.data.added)
                              ? evt.data.added.filter(
                                  (entry): entry is string => typeof entry === "string",
                                )
                              : undefined,
                            modified: Array.isArray(evt.data.modified)
                              ? evt.data.modified.filter(
                                  (entry): entry is string => typeof entry === "string",
                                )
                              : undefined,
                            deleted: Array.isArray(evt.data.deleted)
                              ? evt.data.deleted.filter(
                                  (entry): entry is string => typeof entry === "string",
                                )
                              : undefined,
                            summary: readStringValue(evt.data.summary),
                          });
                        }
                        if (evt.stream === "compaction") {
                          const phase = readStringValue(evt.data.phase) ?? "";
                          const backend = readStringValue(evt.data.backend);
                          const hookMessages = readCompactionHookMessages(evt.data.messages);
                          const sendCompactionUserNotices = async (
                            noticePhase: "start" | "end" | "incomplete",
                          ) => {
                            if (hookMessages.length > 0) {
                              await sendCompactionHookMessages(hookMessages);
                            }
                            if (notifyUserAboutCompaction) {
                              await sendCompactionNotice(noticePhase);
                            }
                          };
                          if (phase === "start") {
                            if (params.opts?.onCompactionStart) {
                              await params.opts.onCompactionStart();
                            }
                            await sendCompactionUserNotices("start");
                          }
                          if (phase === "end") {
                            const completed = evt.data?.completed === true;
                            if (completed) {
                              attemptCompactionCount += 1;
                              if (backend === CODEX_APP_SERVER_COMPACTION_BACKEND) {
                                const modelRef = formatCompactionModelRef(provider, model);
                                const consoleMessage =
                                  `codex app-server auto-compaction succeeded for ${modelRef}; ` +
                                  "refreshed session context";
                                agentCompactionLog.info(
                                  "codex app-server auto-compaction succeeded",
                                  {
                                    event: "codex_app_server_compaction_succeeded",
                                    backend,
                                    provider,
                                    model,
                                    sessionKey: params.sessionKey,
                                    sessionId: effectiveRun.sessionId,
                                    threadId: readStringValue(evt.data.threadId),
                                    turnId: readStringValue(evt.data.turnId),
                                    itemId: readStringValue(evt.data.itemId),
                                    compactionCount: attemptCompactionCount,
                                    consoleMessage,
                                  },
                                );
                              }
                              if (params.opts?.onCompactionEnd) {
                                await params.opts.onCompactionEnd();
                              }
                              await sendCompactionUserNotices("end");
                            } else {
                              await sendCompactionUserNotices("incomplete");
                            }
                          }
                        }
                      };
                    })(),
                    // Always pass onBlockReply so flushBlockReplyBuffer works before tool execution,
                    // even when regular block streaming is disabled. The handler sends directly
                    // via opts.onBlockReply when the pipeline isn't available.
                    onBlockReply: blockReplyHandler,
                    onBlockReplyFlush:
                      params.blockStreamingEnabled && blockReplyPipeline
                        ? async () => {
                            await blockReplyPipeline.flush({ force: true });
                          }
                        : undefined,
                    shouldEmitToolResult: params.shouldEmitToolResult,
                    shouldEmitToolOutput: params.shouldEmitToolOutput,
                    bootstrapPromptWarningSignaturesSeen,
                    bootstrapPromptWarningSignature:
                      bootstrapPromptWarningSignaturesSeen[
                        bootstrapPromptWarningSignaturesSeen.length - 1
                      ],
                    onToolResult: onToolResult
                      ? (() => {
                          // Serialize tool result delivery to preserve message ordering.
                          // Without this, concurrent tool callbacks race through typing signals
                          // and message sends, causing out-of-order delivery to the user.
                          // See: https://github.com/openclaw/openclaw/issues/11044
                          let toolResultChain: Promise<void> = Promise.resolve();
                          return (payload: ReplyPayload) => {
                            toolResultChain = toolResultChain
                              .then(async () => {
                                params.replyOperation?.recordActivity();
                                const { text, skip } = normalizeStreamingText(payload);
                                if (skip) {
                                  return;
                                }
                                if (text !== undefined) {
                                  await params.typingSignals.signalTextDelta(text);
                                }
                                await onToolResult({
                                  ...payload,
                                  text,
                                });
                              })
                              .catch((err: unknown) => {
                                // Keep chain healthy after an error so later tool results still deliver.
                                logVerbose(`tool result delivery failed: ${String(err)}`);
                              });
                            const task = toolResultChain.finally(() => {
                              params.pendingToolTasks.delete(task);
                            });
                            params.pendingToolTasks.add(task);
                          };
                        })()
                      : undefined,
                  }),
                );
                bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
                  embeddedRunResult.meta?.systemPromptReport,
                );
                const resultCompactionCount = Math.max(
                  0,
                  embeddedRunResult.meta?.agentMeta?.compactionCount ?? 0,
                );
                attemptCompactionCount = Math.max(attemptCompactionCount, resultCompactionCount);
                return {
                  result: embeddedRunResult,
                  continueWorkRequests: attemptContinueWorkRequests,
                  compactionTraceparent: attemptCompactionTraceparent,
                };
              } catch (err) {
                if (rollbackFallbackCandidateSelection) {
                  try {
                    await rollbackFallbackCandidateSelection();
                    clearPendingFallbackRollback(rollbackFallbackCandidateSelection);
                  } catch (rollbackError) {
                    logVerbose(
                      `failed to roll back fallback candidate selection (non-fatal): ${String(rollbackError)}`,
                    );
                  }
                }
                throw err;
              } finally {
                autoCompactionCount += attemptCompactionCount;
                revokeMessageActionTurnCapability(messageActionTurnCapability);
              }
            })();
          },
        }),
      );
      agentTurnTiming.logIfSlow({
        runId,
        sessionId: params.followupRun.run.sessionId,
        sessionKey: params.sessionKey,
        outcome: "completed",
      });
      const fallbackRunResult = fallbackResult.result as
        | EmbeddedAgentRunResult
        | {
            result: EmbeddedAgentRunResult;
            continueWorkRequests?: ContinueWorkRequest[];
            compactionTraceparent?: string;
          };
      if (isContinuationWrappedRunResult(fallbackRunResult)) {
        runResult = fallbackRunResult.result;
        continueWorkRequests = fallbackRunResult.continueWorkRequests ?? [];
        compactionTraceparent = fallbackRunResult.compactionTraceparent;
      } else {
        runResult = fallbackRunResult;
        continueWorkRequests = [];
        compactionTraceparent = undefined;
      }
      fallbackProvider = fallbackResult.provider;
      fallbackModel = fallbackResult.model;
      await rollbackClassifiedFallbackCandidateSelection(fallbackProvider, fallbackModel);
      fallbackExhausted = fallbackResult.outcome === "exhausted";
      const settledLifecycleTerminal =
        pendingLifecycleTerminal?.provider === fallbackProvider &&
        pendingLifecycleTerminal.model === fallbackModel
          ? pendingLifecycleTerminal.backstop
          : undefined;
      pendingLifecycleTerminal = undefined;
      const restartAbortReason = runAbortSignal?.reason;
      if (isReplyOperationRestartAbort(params.replyOperation)) {
        settledLifecycleTerminal?.emit("end", runResult);
        throw isAgentRunRestartAbortReason(restartAbortReason)
          ? restartAbortReason
          : createAgentRunRestartAbortError();
      }
      if (isReplyOperationUserAbort(params.replyOperation)) {
        settledLifecycleTerminal?.emit("end", runResult);
        await drainPendingToolTasks({
          tasks: params.pendingToolTasks,
          onTimeout: logVerbose,
        });
        return {
          kind: "final",
          payload: {
            text: SILENT_REPLY_TOKEN,
          },
        };
      }
      commitTerminalOutcome();
      fallbackAttempts = Array.isArray(fallbackResult.attempts)
        ? fallbackResult.attempts.map((attempt) => ({
            provider: attempt.provider,
            model: attempt.model,
            error: attempt.error,
            reason: attempt.reason || undefined,
            status: typeof attempt.status === "number" ? attempt.status : undefined,
            code: attempt.code || undefined,
          }))
        : [];
      if (!fallbackExhausted) {
        await clearRecoveredAutoFallbackPrimaryProbe({
          provider: fallbackProvider,
          model: fallbackModel,
        });
      }

      // Some embedded runs surface context overflow as an error payload instead of throwing.
      // Treat those as a session-level failure and auto-recover by starting a fresh session.
      const embeddedError = runResult.meta?.error;
      const deferredLifecycleError = settledLifecycleTerminal?.getDeferredError();
      const userFacingErrorPayload = runResult.payloads?.find(
        (payload) => payload.isError === true && typeof payload.text === "string",
      )?.text;
      const terminalErrorMessage =
        deferredLifecycleError ??
        userFacingErrorPayload ??
        (embeddedError ? "Agent run failed" : undefined);
      const emitSettledLifecycleError = (error: Error, extraData?: Record<string, unknown>) => {
        if (settledLifecycleTerminal) {
          settledLifecycleTerminal.emit("error", error, extraData);
          return;
        }
        emitAgentEvent({
          runId,
          lifecycleGeneration,
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          stream: "lifecycle",
          data: {
            phase: "error",
            error: error.message,
            endedAt: Date.now(),
            ...extraData,
          },
        });
      };
      if (
        embeddedError &&
        isContextOverflowError(embeddedError.message) &&
        !didResetAfterCompactionFailure
      ) {
        const didResetAfterCompactionFailureNow =
          (await params.resetSessionAfterCompactionFailure?.(embeddedError.message)) ?? false;
        didResetAfterCompactionFailure = didResetAfterCompactionFailureNow;
        emitSettledLifecycleError(new Error(terminalErrorMessage ?? "Agent run failed"));
        defaultRuntime.error(
          `Auto-compaction failed (${embeddedError.message}). Preserving existing session mapping for ${params.sessionKey ?? params.followupRun.run.sessionId}.`,
        );
        params.replyOperation?.fail("run_failed", embeddedError);
        return {
          kind: "final",
          payload: markAgentRunFailureReplyPayload({
            text: buildContextOverflowRecoveryText({
              preserveSessionMapping: !didResetAfterCompactionFailureNow,
              cfg: runtimeConfig,
              agentId: params.followupRun.run.agentId,
              primaryProvider: params.followupRun.run.provider,
              primaryModel: params.followupRun.run.model,
              runtimeProvider: attemptedRuntimeProvider,
              runtimeModel: attemptedRuntimeModel,
              activeSessionEntry: params.getActiveSessionEntry(),
            }),
          }),
        };
      }
      if (embeddedError?.kind === "role_ordering") {
        emitSettledLifecycleError(new Error(terminalErrorMessage ?? "Agent run failed"));
        const providerRequestError = classifyProviderRequestError(embeddedError);
        params.replyOperation?.fail("run_failed", embeddedError);
        const embeddedErrorText = formatErrorMessage(embeddedError).replace(/\.\s*$/, "");
        return {
          kind: "final",
          payload: markAgentRunFailureReplyPayload({
            text: shouldSurfaceToControlUi
              ? `⚠️ Agent failed before reply: ${embeddedErrorText}.\nLogs: openclaw logs --follow`
              : (providerRequestError?.userMessage ??
                PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE),
          }),
        };
      }

      const terminalMetadata = resolveAgentLifecycleTerminalMetadata(runResult.meta);
      if (fallbackExhausted) {
        const exhaustionError = new Error(
          terminalErrorMessage ?? "All model fallback candidates failed",
        );
        terminalRunFailed = true;
        emitSettledLifecycleError(exhaustionError, {
          ...terminalMetadata,
          fallbackExhaustedFailure: true,
        });
        params.replyOperation?.retainFailureUntilComplete();
        params.replyOperation?.fail("run_failed", exhaustionError);
      } else if (deferredLifecycleError || embeddedError) {
        const terminalError = new Error(terminalErrorMessage ?? "Agent run failed");
        terminalRunFailed = true;
        emitSettledLifecycleError(terminalError, terminalMetadata);
        params.replyOperation?.retainFailureUntilComplete();
        params.replyOperation?.fail("run_failed", terminalError);
      } else {
        settledLifecycleTerminal?.emit("end", runResult);
      }
      break;
    } catch (err) {
      if (err instanceof LiveSessionModelSwitchError) {
        liveModelSwitchRetries += 1;
        if (liveModelSwitchRetries > MAX_LIVE_SWITCH_RETRIES) {
          // Prevent infinite loop when persisted session selection keeps
          // conflicting with fallback model choices (e.g. overloaded primary
          // triggers fallback, but session store keeps pulling back to the
          // overloaded model). Surface the last error to the user instead.
          // See: https://github.com/openclaw/openclaw/issues/58348
          defaultRuntime.error(
            `Live model switch failed after ${MAX_LIVE_SWITCH_RETRIES} retries ` +
              `(${sanitizeForLog(err.provider)}/${sanitizeForLog(err.model)}). The requested model may be unavailable.`,
          );
          takePendingLifecycleTerminal()?.emit("error", err);
          const switchErrorText = shouldSurfaceToControlUi
            ? "⚠️ Agent failed before reply: model switch could not be completed. " +
              "The requested model may be temporarily unavailable.\n" +
              "Logs: openclaw logs --follow"
            : isVerboseFailureDetailEnabled(params.resolvedVerboseLevel)
              ? "⚠️ Agent failed before reply: model switch could not be completed. " +
                "The requested model may be temporarily unavailable. Please try again shortly."
              : "⚠️ Model switch could not be completed. The requested model may be temporarily unavailable. Please try again shortly.";
          params.replyOperation?.fail("run_failed", err);
          return {
            kind: "final",
            payload: markAgentRunFailureReplyPayload({
              text: resolveExternalRunFailureTextForConversation({
                text: switchErrorText,
                sessionCtx: params.sessionCtx,
                isGenericRunnerFailure: !shouldSurfaceToControlUi,
                cfg: params.followupRun.run.config,
              }),
            }),
          };
        }
        applyLiveModelSwitchToRun(params.followupRun.run, err);
        if (runnableRun !== params.followupRun.run) {
          applyLiveModelSwitchToRun(runnableRun, err);
        }
        if (effectiveRun !== runnableRun && effectiveRun !== params.followupRun.run) {
          applyLiveModelSwitchToRun(effectiveRun, err);
        }
        pendingLifecycleTerminal = undefined;
        fallbackProvider = err.provider;
        fallbackModel = err.model;
        continue;
      }
      const message = formatErrorMessage(err);
      agentTurnTiming.logIfSlow({
        runId,
        sessionId: params.followupRun.run.sessionId,
        sessionKey: params.sessionKey,
        outcome: "error",
        error: message,
      });
      const isBilling = isFallbackSummaryError(err)
        ? hasBillingAttemptSummary(err)
        : isFailoverError(err)
          ? err.reason === "billing"
          : isBillingErrorMessage(message);
      const isContextOverflow = !isBilling && isLikelyContextOverflowError(message);
      const isCompactionFailure = !isBilling && isCompactionFailureError(message);
      const isSessionCorruption = /function call turn comes immediately after/i.test(message);
      // OAuth/auth-profile failures must reach buildExternalRunFailureReply so
      // the targeted re-auth/failover copy is surfaced instead of the generic
      // provider-auth message.
      const oauthRefreshFailure =
        classifyOAuthRefreshFailureError(err) ?? classifyOAuthRefreshFailure(message);
      const hasAuthProfileFailoverFailure = buildAuthProfileFailoverFailureText(err) !== null;
      const providerRequestError =
        !isBilling &&
        !oauthRefreshFailure &&
        !hasAuthProfileFailoverFailure &&
        !shouldSurfaceToControlUi
          ? classifyProviderRequestError(err)
          : undefined;
      const isTransientHttp = isTransientHttpError(message);

      // Drain/restart aborts stay silent and defer to post-restart
      // main-session recovery, which resumes the interrupted turn (or emits its
      // own genuine non-resumable notice). A generic "try again" here is a
      // false terminal that invites a duplicate manual retry. Restart abort is
      // treated exactly like user abort for visible output; the fail()
      // bookkeeping for drain/lane-cleared is still recorded.
      if (isReplyOperationRestartAbort(params.replyOperation)) {
        takePendingLifecycleTerminal()?.emit("end", err);
        if (params.isRestartRecoveryArmed?.() !== true) {
          return {
            kind: "final",
            payload: markAgentRunFailureReplyPayload({
              text: buildRestartLifecycleReplyText(),
            }),
          };
        }
        return {
          kind: "final",
          payload: {
            text: SILENT_REPLY_TOKEN,
          },
        };
      }

      if (isReplyOperationUserAbort(params.replyOperation)) {
        takePendingLifecycleTerminal()?.emit("error", err);
        return {
          kind: "final",
          payload: {
            text: SILENT_REPLY_TOKEN,
          },
        };
      }

      const restartLifecycleError = resolveRestartLifecycleError(err);
      if (restartLifecycleError instanceof GatewayDrainingError) {
        takePendingLifecycleTerminal()?.emit("error", restartLifecycleError);
        params.replyOperation?.fail("gateway_draining", restartLifecycleError);
        return {
          kind: "final",
          payload: markAgentRunFailureReplyPayload({
            text: buildRestartLifecycleReplyText(),
          }),
        };
      }

      if (restartLifecycleError instanceof CommandLaneClearedError) {
        takePendingLifecycleTerminal()?.emit("error", restartLifecycleError);
        params.replyOperation?.fail("command_lane_cleared", restartLifecycleError);
        return {
          kind: "final",
          payload: markAgentRunFailureReplyPayload({
            text: buildRestartLifecycleReplyText(),
          }),
        };
      }

      if (isCompactionFailure && !didResetAfterCompactionFailure) {
        const didResetAfterCompactionFailureNow =
          (await params.resetSessionAfterCompactionFailure?.(message)) ?? false;
        takePendingLifecycleTerminal()?.emit("error", err);
        defaultRuntime.error(
          `Auto-compaction failed (${message}). Preserving existing session mapping for ${params.sessionKey ?? params.followupRun.run.sessionId}.`,
        );
        params.replyOperation?.fail("run_failed", err);
        return {
          kind: "final",
          payload: markAgentRunFailureReplyPayload({
            text: buildContextOverflowRecoveryText({
              duringCompaction: true,
              preserveSessionMapping: !didResetAfterCompactionFailureNow,
              cfg: runtimeConfig,
              agentId: params.followupRun.run.agentId,
              primaryProvider: params.followupRun.run.provider,
              primaryModel: params.followupRun.run.model,
              runtimeProvider: attemptedRuntimeProvider,
              runtimeModel: attemptedRuntimeModel,
              activeSessionEntry: params.getActiveSessionEntry(),
            }),
          }),
        };
      }

      // Auto-recover from Gemini session corruption by resetting the session
      if (
        isSessionCorruption &&
        params.sessionKey &&
        params.activeSessionStore &&
        params.storePath
      ) {
        const sessionKey = params.sessionKey;
        const corruptedSessionId = params.getActiveSessionEntry()?.sessionId;
        defaultRuntime.error(
          `Session history corrupted (Gemini function call ordering). Resetting session: ${params.sessionKey}`,
        );

        try {
          // Delete transcript file if it exists
          if (corruptedSessionId) {
            const transcriptPath = resolveSessionTranscriptPath(corruptedSessionId);
            try {
              fs.unlinkSync(transcriptPath);
            } catch {
              // Ignore if file doesn't exist
            }
          }

          // Keep the in-memory snapshot consistent with the on-disk store reset.
          {
            const memResolved = resolveSessionStoreEntry({
              store: params.activeSessionStore,
              sessionKey,
            });
            delete params.activeSessionStore[memResolved.normalizedKey];
            for (const legacyKey of memResolved.legacyKeys) {
              delete params.activeSessionStore[legacyKey];
            }
          }

          // Remove session entry from store using a fresh, locked snapshot.
          await removeSessionEntry({ storePath: params.storePath, sessionKey });
        } catch (cleanupErr) {
          defaultRuntime.error(
            `Failed to reset corrupted session ${params.sessionKey}: ${String(cleanupErr)}`,
          );
        }

        params.replyOperation?.fail("session_corruption_reset", err);
        return {
          kind: "final",
          payload: markAgentRunFailureReplyPayload({
            text: "⚠️ Session history was corrupted. I've reset the conversation - please try again!",
          }),
        };
      }

      if (providerRequestError) {
        takePendingLifecycleTerminal()?.emit("error", err);
        params.replyOperation?.fail("run_failed", err);
        return {
          kind: "final",
          payload: markAgentRunFailureReplyPayload({
            text: providerRequestError.userMessage,
          }),
        };
      }

      if (isTransientHttp && consumeTransientHttpRetry()) {
        pendingLifecycleTerminal = undefined;
        // Retry the full runWithModelFallback() cycle — transient errors
        // (502/521/etc.) typically affect the whole provider, so falling
        // back to an alternate model first would not help. Instead we wait
        // and retry the complete primary→fallback chain.
        defaultRuntime.error(
          `Transient HTTP provider error before reply (${message}). Retrying once in ${TRANSIENT_HTTP_RETRY_DELAY_MS}ms.`,
        );
        await new Promise<void>((resolve) => {
          setTimeout(resolve, TRANSIENT_HTTP_RETRY_DELAY_MS);
        });
        continue;
      }

      defaultRuntime.error(`Embedded agent failed before reply: ${message}`);
      // Only classify as rate-limit when we have concrete evidence from the
      // underlying error. FallbackSummaryError messages embed per-attempt
      // reason labels like `(rate_limit)`, so string-matching the summary text
      // would misclassify mixed-cause exhaustion as a pure transient cooldown.
      const isFallbackSummary = isFallbackSummaryError(err);
      const isPureTransientSummary = isFallbackSummary
        ? isPureTransientRateLimitSummary(err)
        : false;
      const failoverReason = !isFallbackSummary && isFailoverError(err) ? err.reason : undefined;
      const isOverloaded = failoverReason === "overloaded" || isOverloadedErrorMessage(message);
      const isRateLimit = isFallbackSummary
        ? isPureTransientSummary
        : failoverReason
          ? failoverReason === "rate_limit" || failoverReason === "overloaded"
          : isRateLimitErrorMessage(message);
      const rateLimitOrOverloadedCopy =
        !isFallbackSummary || isPureTransientSummary
          ? formatRateLimitOrOverloadedErrorCopy(
              failoverReason === "overloaded" ? "overloaded" : message,
            )
          : undefined;
      const safeMessage = isTransientHttp
        ? sanitizeUserFacingText(message, { errorContext: true })
        : message;
      const trimmedMessage = safeMessage.replace(/\.\s*$/, "");
      const externalRunFailureReply =
        !isBilling &&
        !(isRateLimit && !isOverloaded) &&
        !rateLimitOrOverloadedCopy &&
        !isContextOverflow &&
        !shouldSurfaceToControlUi
          ? buildExternalRunFailureReply(
              { message, error: err },
              {
                includeAuthProfileId: !isNonDirectConversationContext(params.sessionCtx),
                includeDetails: isVerboseFailureDetailEnabled(params.resolvedVerboseLevel),
                isHeartbeat: params.isHeartbeat,
              },
            )
          : undefined;
      const genericFallbackText = params.isHeartbeat
        ? HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT
        : GENERIC_EXTERNAL_RUN_FAILURE_TEXT;
      const fallbackText = isBilling
        ? resolveBillingFailureReplyText(err)
        : isRateLimit && !isOverloaded
          ? buildRateLimitCooldownMessage(err)
          : rateLimitOrOverloadedCopy
            ? rateLimitOrOverloadedCopy
            : isContextOverflow
              ? "⚠️ Context overflow — prompt too large for this model. Try a shorter message or a larger-context model."
              : shouldSurfaceToControlUi
                ? `⚠️ Agent failed before reply: ${trimmedMessage}.\nLogs: openclaw logs --follow`
                : (externalRunFailureReply?.text ?? genericFallbackText);
      const userVisibleFallbackText = resolveExternalRunFailureTextForConversation({
        text: fallbackText,
        sessionCtx: params.sessionCtx,
        isGenericRunnerFailure: externalRunFailureReply?.isGenericRunnerFailure ?? false,
        cfg: params.followupRun.run.config,
      });
      const abortedSignal =
        params.replyOperation?.abortSignal.aborted === true
          ? params.replyOperation.abortSignal
          : params.opts?.abortSignal?.aborted === true
            ? params.opts.abortSignal
            : undefined;
      const abortLifecycleFields = {
        ...resolveAgentRunErrorLifecycleFields(err, abortedSignal),
        ...(isReplyOperationRestartAbort(params.replyOperation)
          ? {
              aborted: true as const,
              stopReason: AGENT_RUN_RESTART_ABORT_STOP_REASON,
            }
          : {}),
      };

      const failedLifecycleTerminal = takePendingLifecycleTerminal();
      if (failedLifecycleTerminal) {
        failedLifecycleTerminal.emit("error", err, {
          fallbackExhaustedFailure: true,
        });
      } else {
        emitAgentEvent({
          runId,
          lifecycleGeneration,
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          stream: "lifecycle",
          data: {
            phase: "error",
            error: message,
            endedAt: Date.now(),
            ...abortLifecycleFields,
            fallbackExhaustedFailure: true,
          },
        });
      }
      params.replyOperation?.fail("run_failed", err);
      return {
        kind: "final",
        payload: markAgentRunFailureReplyPayload({
          text: userVisibleFallbackText,
        }),
      };
    }
  }

  // If the run completed but with an embedded context overflow error that
  // wasn't recovered from (e.g. compaction reset already attempted), surface
  // the error to the user instead of silently returning an empty response.
  // See #26905: Slack DM sessions silently swallowed messages when context
  // overflow errors were returned as embedded error payloads.
  const finalEmbeddedError = runResult?.meta?.error;
  const hasPayloadText = runResult?.payloads?.some((p) => normalizeOptionalString(p.text));
  // #475+#487 reconcile (option c): #487 prepends a standalone blocked-liveness
  // notice payload; #475 (#481) prefixes existing error payloads with a blocked
  // marker. Both fire on `livenessState === "blocked"`, producing double-emit
  // (notice + prefixed-error) when both an error payload and blocked liveness
  // are present. Tests written against #475's contract expect single-payload
  // outcomes. Gate #487's prepend on the absence of an error payload so the
  // notice surfaces only as the silent-blocked fallback (no error to prefix);
  // when an error payload is present, #475's prefix carries the blocked-state
  // signal alone.
  const hasErrorPayload = runResult?.payloads?.some((p) => p.isError) ?? false;
  if (
    runResult?.meta?.livenessState === "blocked" &&
    !didSurfaceBlockedLivenessState &&
    !hasErrorPayload
  ) {
    runResult.payloads = [
      {
        text: BLOCKED_LIVENESS_NOTICE_TEXT,
        isError: true,
      },
      ...(runResult.payloads ?? []),
    ];
    didSurfaceBlockedLivenessState = true;
  }
  if (finalEmbeddedError && !hasPayloadText) {
    const errorMsg = finalEmbeddedError.message ?? "";
    if (isContextOverflowError(errorMsg)) {
      params.replyOperation?.fail("run_failed", finalEmbeddedError);
      return {
        kind: "final",
        payload: markAgentRunFailureReplyPayload({
          text: "⚠️ Context overflow — this conversation is too large for the model. Use /new to start a fresh session.",
        }),
      };
    }
  }

  // #475: surface terminal blocked livenessState as a channel-visible marker.
  // The embedded runner sets `meta.livenessState = "blocked"` on terminal
  // give-up paths (compaction-failure cap, strict-agentic blocked, role-ordering
  // give-up, etc.) but channel consumers never read this metadata. Operators
  // could not distinguish a normal error reply from a session that gave up
  // after exhausting compaction retries. Inject a one-line marker prefix on the
  // outbound error payload(s) when liveness is blocked AND the payload hasn't
  // already been auto-recovered or replaced by a more specific marker.
  // (B-shape cascade-phase observability is tracked separately as a follow-up
  // PR — it requires a new typing/status protocol surface.)
  const finalLivenessState = runResult?.meta?.livenessState;
  if (
    runResult &&
    finalLivenessState === "blocked" &&
    Array.isArray(runResult.payloads) &&
    runResult.payloads.length > 0
  ) {
    const blockedMarker = "⛔ Session blocked: ";
    runResult.payloads = runResult.payloads.map((payload) => {
      if (!payload.isError) {
        return payload;
      }
      const text = normalizeOptionalString(payload.text);
      if (!text) {
        return payload;
      }
      if (text.startsWith(blockedMarker)) {
        return payload;
      }
      // #475+#487 reconcile: skip the standalone blocked-liveness notice
      // sentinel so it surfaces unprefixed. The notice is itself a blocked-
      // state marker; prefixing it produces a "⛔ Session blocked: ⚠️ Agent
      // liveness: blocked..." chimera that fails the single-marker contract.
      if (text.startsWith(BLOCKED_LIVENESS_NOTICE_TEXT)) {
        return payload;
      }
      return { ...payload, text: `${blockedMarker}${text}` };
    });
  }

  // Surface rate limit and overload errors that occur mid-turn (after tool
  // calls) instead of silently returning an empty response. See #36142.
  // Only applies when the assistant produced no valid (non-error) reply text,
  // so tool-level rate-limit messages don't override a successful turn.
  // Prioritize metaErrorMsg (raw upstream error) over errorPayloadText to
  // avoid self-matching on pre-formatted "⚠️" messages from run.ts, and
  // skip already-formatted payloads so tool-specific 429 errors (e.g.
  // browser/search tool failures) are preserved rather than overwritten.
  //
  // Instead of early-returning kind:"final" (which would bypass
  // buildReplyPayloads() filtering and session bookkeeping), inject the
  // error payload into runResult so it flows through the normal
  // kind:"success" path — preserving streaming dedup, message_send
  // suppression, and usage/model metadata updates.
  if (runResult) {
    const hasNonErrorContent = runResult.payloads?.some(
      (p) => !p.isError && !p.isReasoning && hasOutboundReplyContent(p, { trimText: true }),
    );
    if (!hasNonErrorContent) {
      const metaErrorMsg = finalEmbeddedError?.message ?? "";
      const rawErrorPayloadText =
        runResult.payloads?.find(
          (p) => p.isError && hasNonEmptyString(p.text) && !p.text.startsWith("⚠️"),
        )?.text ?? "";
      const errorCandidate = metaErrorMsg || rawErrorPayloadText;
      const formattedErrorCandidate = errorCandidate
        ? formatRateLimitOrOverloadedErrorCopy(errorCandidate)
        : undefined;
      if (formattedErrorCandidate) {
        runResult.payloads = [
          markAgentRunFailureReplyPayload({
            text: resolveExternalRunFailureTextForConversation({
              text: formattedErrorCandidate,
              sessionCtx: params.sessionCtx,
              isGenericRunnerFailure: false,
              cfg: params.followupRun.run.config,
            }),
            isError: true,
          }),
        ];
      }
    }
  }
  const terminalFailurePayload = terminalRunFailed
    ? buildTerminalAgentRunFailureReplyPayload({
        isHeartbeat: params.isHeartbeat,
        sessionCtx: params.sessionCtx,
        cfg: params.followupRun.run.config,
      })
    : undefined;

  return {
    kind: "success",
    runId,
    runResult,
    fallbackProvider,
    fallbackModel,
    ...(fallbackExhausted ? { fallbackExhausted: true as const } : {}),
    fallbackAttempts,
    didLogHeartbeatStrip,
    autoCompactionCount,
    compactionTraceparent,
    directlySentBlockKeys: directlySentBlockKeys.size > 0 ? directlySentBlockKeys : undefined,
    continueWorkRequests,
    directlySentBlockPayloads: directlySentBlockPayloads.filter(
      (payload): payload is ReplyPayload => payload !== undefined,
    ),
    ...(terminalFailurePayload ? { terminalFailurePayload } : {}),
  };
}

/** Runs the agent turn with provider/model fallback, retry, and failure mapping. */
export async function runAgentTurnWithFallback(
  params: Parameters<typeof runAgentTurnWithFallbackInternal>[0],
): Promise<AgentRunLoopResult> {
  let terminalOutcomeCommitted = false;
  const commitTerminalOutcome = () => {
    if (terminalOutcomeCommitted) {
      return;
    }
    terminalOutcomeCommitted = true;
    params.replyOperation?.freezeAbort();
  };
  try {
    return await runAgentTurnWithFallbackInternal(params, commitTerminalOutcome);
  } finally {
    commitTerminalOutcome();
  }
}
