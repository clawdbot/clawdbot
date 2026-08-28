/** Per-row execution for durable same-session continuation work. */

import type { SubagentRunLiveness } from "../../agents/subagents/registry/subagent-run-liveness.js";
import {
  emitContinuationWorkFireSpan,
  resolveContinuationTraceparent,
} from "../../infra/continuation-tracer.js";
import { runWithDiagnosticTraceparent } from "../../infra/diagnostic-trace-context.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isRetryableHeartbeatBusySkipReason } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEventRaw as enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { evaluateNoOpRearmAdmission, type NoOpRearmDecision } from "../reply/no-op-rearm-guard.js";
import type { ContinuationWorkReasonCategory, PendingContinuationWork } from "./work-flow-state.js";
import {
  markPendingWorkDelivered,
  markPendingWorkFailed,
  markPendingWorkFoldDelivered,
  markPendingWorkFolded,
  markPendingWorkReaped,
  markPendingWorkSuperseded,
  markPendingWorkTurnGranted,
  reconcileUndeliverableGrantedWork,
  revalidatePendingWorkForTurn,
  requeuePendingWork,
} from "./work-store.js";
import { deliverPendingTerminalNoticeWithRetry } from "./work-terminal-notice.js";

const log = createSubsystemLogger("continuation/work-dispatch");
const TRANSIENT_ERROR_RETRY_MS = 5_000;
const MAX_TRANSIENT_ERROR_RETRY_COUNT = 8;
const CONTINUATION_TURN_BUSY_REASON = "requests-in-flight";
const CONTINUATION_TURN_COMMAND_QUEUE_BUSY_REASON = "command-queue-busy";
const CONTINUATION_TURN_DRAINING_REASON = "draining";
// Non-retryable: the no-op replay guard tripped. The row is
// terminal-parked (superseded) so the self-rearm loop stops; never requeued.
const CONTINUATION_TURN_NOOP_REARM_BLOCKED_REASON = "noop-rearm-blocked";
const CONTINUATION_TURN_RESET_REASON = "session-reset";
const CONTINUATION_TURN_LIFECYCLE_CHANGED_REASON = "session-lifecycle-changed";
const CONTINUATION_TURN_STALE_CLAIM_REASON = "stale-claim";
const GATEWAY_RESTARTING_REPLY_TEXT =
  "⚠️ Gateway is restarting. Please wait a few seconds and try again.";

type ReplyRunRegistry = (typeof import("../reply/reply-run-registry.js"))["replyRunRegistry"];

// The dynamic edge keeps the reply graph out of the continuation static graph.
// One promise is load-bearing: admission, election, and idle waits must observe
// the same registry instance even while the module import is still in flight.
let replyRunRegistryModulePromise:
  | Promise<typeof import("../reply/reply-run-registry.js")>
  | undefined;

export async function getContinuationReplyRunRegistry(): Promise<ReplyRunRegistry> {
  replyRunRegistryModulePromise ??= import("../reply/reply-run-registry.js");
  return (await replyRunRegistryModulePromise).replyRunRegistry;
}

export type ContinuationWorkIdleRetryTrigger =
  | { kind: "reply-run-ended" }
  | { kind: "command-lane-idle"; lane: string };

type ContinuationWorkExecutionPolicy = Readonly<{
  reasonCategory: ContinuationWorkReasonCategory;
  busyRetryDelayMs: number;
  idleRetryHedgeMs: number;
  mainCommandLane: string;
  orphanReapStaleCutoffMs?: number;
}>;

export type ContinuationWorkExecutionDirective = Readonly<
  | { kind: "dispatched" }
  | { kind: "failed" }
  | { kind: "cancelled" }
  | { kind: "reaped" }
  | {
      kind: "requeued";
      sessionKey: string;
      dueAt: number;
      retryTrigger?: ContinuationWorkIdleRetryTrigger;
    }
  | { kind: "unchanged" }
>;

type ContinuationWorkFoldExecutionResult = Readonly<{
  folded: number;
  requeues: readonly Extract<ContinuationWorkExecutionDirective, { kind: "requeued" }>[];
}>;

type ContinuationWorkFoldCandidate = Readonly<{
  work: PendingContinuationWork;
  reasonCategory: ContinuationWorkReasonCategory;
}>;

type ContinuationWorkFoldAttempt = Readonly<{
  now: number;
  retryDelayMs: number;
  delivery: { delivered: true; deliveredAt: number } | { delivered: false; reason: string };
}>;

type ContinuationWorkFoldPolicy = Readonly<{
  deliveryTimeoutMs: number;
  retryDelayMs: number;
}>;

function isRetryableContinuationSkipReason(reason: string): boolean {
  return (
    isRetryableHeartbeatBusySkipReason(reason) ||
    reason === CONTINUATION_TURN_DRAINING_REASON ||
    reason === CONTINUATION_TURN_COMMAND_QUEUE_BUSY_REASON ||
    reason === CONTINUATION_TURN_LIFECYCLE_CHANGED_REASON
  );
}

/** Emit the guard's single per-episode suppression diagnostic, when present. */
function emitNoOpRearmBlockedDiagnostic(decision: NoOpRearmDecision): void {
  if (!decision.admit && decision.diagnostic) {
    log.warn(decision.diagnostic.message);
  }
}

/** Read the latest parent liveness from the live registry; never persist it. */
async function readChildSessionRunLiveness(
  sessionKey: string,
  options: { now: number; staleCutoffMs?: number },
): Promise<SubagentRunLiveness> {
  const [{ subagentRuns }, { classifyChildSessionRunLivenessFromRuns }] = await Promise.all([
    import("../../agents/subagents/registry/subagent-registry-memory.js"),
    import("../../agents/subagents/registry/subagent-registry-queries.js"),
  ]);
  return classifyChildSessionRunLivenessFromRuns(subagentRuns, sessionKey, options);
}

type ReplyPayloadLike = { text?: unknown };

function isReplyPayloadLike(value: unknown): value is ReplyPayloadLike {
  return Boolean(value && typeof value === "object");
}

function isGatewayRestartingReplyPayload(value: unknown): boolean {
  return isReplyPayloadLike(value) && value.text === GATEWAY_RESTARTING_REPLY_TEXT;
}

function hasNonDrainReplyPayload(reply: unknown): boolean {
  if (reply === undefined) {
    return false;
  }
  const payloads = Array.isArray(reply) ? reply : [reply];
  return payloads.some((payload) => !isGatewayRestartingReplyPayload(payload));
}

function isoOrUndefined(ms: number | undefined): string | undefined {
  return ms !== undefined ? new Date(ms).toISOString() : undefined;
}

function quotePriorReason(reason: string | undefined): string {
  return reason ? JSON.stringify(reason) : "(none)";
}

type ContinuationProvenanceDisposition =
  | { disposition: "granted"; deliveredAt: number }
  | { disposition: "folded-active"; foldedAt: number };

function provenanceLines(
  work: PendingContinuationWork,
  now: number,
  terminal?: ContinuationProvenanceDisposition,
): string[] {
  const overdueByMs = Math.max(0, now - work.dueAt);
  const lines: string[] = [];
  if (work.originRunId) {
    lines.push(`Origin run: ${work.originRunId}`);
  }
  if (work.originTurnId) {
    lines.push(`Origin turn: ${work.originTurnId}`);
  }
  lines.push(`Elected at: ${isoOrUndefined(work.electedAt) ?? "unknown"}`);
  if (work.anchorFinalizedAt !== undefined) {
    lines.push(`Electing turn finalized at: ${isoOrUndefined(work.anchorFinalizedAt)}`);
  }
  lines.push(`Due at: ${isoOrUndefined(work.dueAt) ?? "unknown"}`);
  lines.push(`Overdue by: ${overdueByMs}ms`);
  if (terminal?.disposition === "granted") {
    lines.push(`Delivered at: ${isoOrUndefined(terminal.deliveredAt)}`);
  } else if (terminal?.disposition === "folded-active") {
    lines.push(`Folded at: ${isoOrUndefined(terminal.foldedAt)}`);
  }
  if (terminal) {
    lines.push(`Disposition: ${terminal.disposition}`);
  }
  lines.push(
    `Chain: ${work.chainId ?? work.flowId ?? "n/a"} hop ${work.hop}/${work.maxChainLength}`,
  );
  lines.push(`Flow: ${work.flowId ?? "n/a"}`);
  lines.push(`Prior reason: ${quotePriorReason(work.reason)}`);
  return lines;
}

function formatContinuationWakeText(work: PendingContinuationWork): string {
  const deliveredAt = Date.now();
  const provenance = provenanceLines(work, deliveredAt, {
    disposition: "granted",
    deliveredAt,
  }).join(" ");
  return (
    `[continuation:wake] Turn ${work.hop}/${work.maxChainLength}. ` +
    (work.chainStartedAt !== undefined
      ? `Chain started at ${new Date(work.chainStartedAt).toISOString()}. `
      : "") +
    (work.accumulatedChainTokens !== undefined
      ? `Accumulated tokens: ${work.accumulatedChainTokens}. `
      : "") +
    `The agent elected to continue working.` +
    (work.reason ? ` Prior reason: ${quotePriorReason(work.reason)}` : "") +
    ` [provenance] ${provenance}`
  );
}

const MAX_FOLD_NOTE_DETAILED = 5;
const MAX_FOLD_NOTE_OMITTED_FLOW_IDS = 5;

function buildFoldedProvenanceNote(works: readonly PendingContinuationWork[], now: number): string {
  const header =
    works.length === 1
      ? `[system:continuation-note] A prior same-session continue_work intent matured while this session was active. It was folded into this turn and will not fire separately as a new turn.`
      : `[system:continuation-note] ${works.length} prior same-session continue_work intents matured while this session was active. They were folded into this turn and will not fire separately as new turns.`;
  const ordered = works.toSorted((a, b) => b.electedAt - a.electedAt);
  const detailed = ordered.slice(0, MAX_FOLD_NOTE_DETAILED);
  const blocks = detailed.map((work, index) => {
    const label =
      works.length === 1 ? "Folded intent" : `Folded intent ${index + 1}/${works.length}`;
    return `${label}:\n${provenanceLines(work, now, {
      disposition: "folded-active",
      foldedAt: now,
    }).join("\n")}`;
  });
  const omitted = ordered.length - detailed.length;
  const tail =
    omitted > 0
      ? `\n(${omitted} older folded continuation${omitted === 1 ? "" : "s"} omitted; sample flowIds ${ordered
          .slice(MAX_FOLD_NOTE_DETAILED)
          .slice(0, MAX_FOLD_NOTE_OMITTED_FLOW_IDS)
          .map((work) => work.flowId ?? "n/a")
          .join(", ")}${omitted > MAX_FOLD_NOTE_OMITTED_FLOW_IDS ? ", ..." : ""})`
      : "";
  const guidance =
    "\nTreat these as prior-turn context, not fresh commands. Re-evaluate before acting; the rows were consumed and will not fire separately.";
  return `${header}\n\n${blocks.join("\n\n")}${tail}${guidance}`;
}

type ContinuationTurnGrantResult =
  | { status: "ran"; work: PendingContinuationWork }
  // Turn ran, but the durable delivered-mark lost the revision race and the row
  // was reconciled here. The caller must not finish with the stale revision.
  | { status: "ran-finalized" }
  | { status: "skipped"; reason: string; retryTrigger?: ContinuationWorkIdleRetryTrigger };

async function driveContinuationTurn(
  work: PendingContinuationWork,
  wakeText: string,
  mainCommandLane: string,
  signal: AbortSignal,
): Promise<ContinuationTurnGrantResult> {
  const [
    { getRuntimeConfig },
    { resolveSessionStorePathCore },
    { loadSessionEntry },
    { parseAgentSessionKey, isSubagentSessionKey },
    { resolveSessionLane },
    { getReplyFromConfig },
    replyRunRegistry,
    { getQueueSize, isGatewayDraining },
  ] = await Promise.all([
    import("../../config/config.js"),
    import("../../config/sessions/paths.js"),
    import("../../config/sessions/session-accessor.js"),
    import("../../sessions/session-key-utils.js"),
    import("../../agents/embedded-agent-runner/lanes.js"),
    import("../reply/get-reply.js"),
    getContinuationReplyRunRegistry(),
    import("../../process/command-queue.js"),
  ]);

  // Direct continuation grants bypass heartbeat policy, but still respect
  // gateway drain, the session's active reply, and queued main-lane work.
  if (isGatewayDraining()) {
    return { status: "skipped", reason: CONTINUATION_TURN_DRAINING_REASON };
  }
  if (replyRunRegistry.isActive(work.sessionKey)) {
    return {
      status: "skipped",
      reason: CONTINUATION_TURN_BUSY_REASON,
      retryTrigger: { kind: "reply-run-ended" },
    };
  }
  const continuationLane = isSubagentSessionKey(work.sessionKey)
    ? resolveSessionLane(work.sessionKey)
    : undefined;
  if (continuationLane === undefined && getQueueSize(mainCommandLane) > 0) {
    return {
      status: "skipped",
      reason: CONTINUATION_TURN_COMMAND_QUEUE_BUSY_REASON,
      retryTrigger: { kind: "command-lane-idle", lane: mainCommandLane },
    };
  }

  const cfg = getRuntimeConfig();
  const agentId = parseAgentSessionKey(work.sessionKey)?.agentId;
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  const agentSessionEntry = loadSessionEntry({
    clone: false,
    hydrateSkillPromptRefs: false,
    readConsistency: "latest",
    sessionKey: work.sessionKey,
    storePath,
  });
  if (!agentSessionEntry) {
    return { status: "skipped", reason: "missing-session" };
  }
  const admittedSessionIdentity = {
    sessionId: agentSessionEntry.sessionId,
    lifecycleRevision: agentSessionEntry.lifecycleRevision,
  };

  const admission = evaluateNoOpRearmAdmission({
    sessionKey: work.sessionKey,
    isContinuationWake: true,
    ...(work.parentRunId ? { parentRunId: work.parentRunId } : {}),
  });
  if (!admission.admit) {
    emitNoOpRearmBlockedDiagnostic(admission);
    return { status: "skipped", reason: CONTINUATION_TURN_NOOP_REARM_BLOCKED_REASON };
  }

  if (signal.aborted) {
    return { status: "skipped", reason: CONTINUATION_TURN_RESET_REASON };
  }
  const workFence = revalidatePendingWorkForTurn(work);
  if (!workFence.allowed) {
    return {
      status: "skipped",
      reason:
        workFence.reason === "cancelled"
          ? CONTINUATION_TURN_RESET_REASON
          : CONTINUATION_TURN_STALE_CLAIM_REASON,
    };
  }
  const currentSessionEntry = loadSessionEntry({
    clone: false,
    hydrateSkillPromptRefs: false,
    readConsistency: "latest",
    sessionKey: work.sessionKey,
    storePath,
  });
  if (
    currentSessionEntry?.sessionId !== admittedSessionIdentity.sessionId ||
    currentSessionEntry?.lifecycleRevision !== admittedSessionIdentity.lifecycleRevision
  ) {
    return { status: "skipped", reason: CONTINUATION_TURN_LIFECYCLE_CHANGED_REASON };
  }
  const reply = await runWithDiagnosticTraceparent(work.traceparent, () =>
    getReplyFromConfig(
      {
        Body: wakeText,
        BodyForCommands: wakeText,
        CommandBody: wakeText,
        Provider: "system",
        Surface: "system",
        From: "system",
        To: "agent",
        SessionKey: work.sessionKey,
        RuntimePolicySessionKey: work.sessionKey,
        ...(agentId ? { AgentId: agentId } : {}),
      },
      {
        continuationTrigger: "work-wake",
        abortSignal: signal,
        parentRunId: work.parentRunId,
        lane: continuationLane,
        typingPolicy: "system_event",
        suppressTyping: true,
      },
      cfg,
    ),
  );
  if (!hasNonDrainReplyPayload(reply) && isGatewayDraining()) {
    return { status: "skipped", reason: CONTINUATION_TURN_DRAINING_REASON };
  }
  // The provider ran. Persist the replay guard before finishing, then advance
  // only with the committed revision-bearing value returned by the CAS.
  const deliveredMark = markPendingWorkDelivered(work);
  if (!deliveredMark.applied) {
    reconcileUndeliverableGrantedWork(work);
    return { status: "ran-finalized" };
  }
  return { status: "ran", work: deliveredMark.work };
}

async function deliverFoldedProvenanceNoteToActiveTurn(params: {
  sessionKey: string;
  note: string;
  deliveryTimeoutMs: number;
}): Promise<{ delivered: true; deliveredAt: number } | { delivered: false; reason: string }> {
  const replyRunRegistry = await getContinuationReplyRunRegistry();
  const sessionId = replyRunRegistry.resolveSessionId(params.sessionKey);
  if (!sessionId) {
    return { delivered: false, reason: "missing-active-session-id" };
  }
  const { isEmbeddedAgentRunHandleActive, queueEmbeddedAgentMessageWithOutcomeAsync } =
    await import("../../agents/embedded-agent-runner/runs.js");
  if (!isEmbeddedAgentRunHandleActive(sessionId)) {
    return { delivered: false, reason: "active-embedded-run-required-for-transcript-proof" };
  }
  const outcome = await queueEmbeddedAgentMessageWithOutcomeAsync(sessionId, params.note, {
    steeringMode: "all",
    debounceMs: 0,
    deliveryTimeoutMs: params.deliveryTimeoutMs,
    waitForTranscriptCommit: true,
  });
  if (outcome.queued && outcome.deliveredAtMs !== undefined) {
    return { delivered: true, deliveredAt: outcome.deliveredAtMs };
  }
  if (outcome.queued) {
    return { delivered: false, reason: `queued-without-transcript-commit:${outcome.target}` };
  }
  return { delivered: false, reason: outcome.reason };
}

export async function prepareFoldedContinuationWork(
  sessionKey: string,
  candidates: readonly ContinuationWorkFoldCandidate[],
  policy: ContinuationWorkFoldPolicy,
): Promise<ContinuationWorkFoldAttempt> {
  const works = candidates.map((candidate) => candidate.work);
  const now = Date.now();
  const note = buildFoldedProvenanceNote(works, now);
  let delivery: Awaited<ReturnType<typeof deliverFoldedProvenanceNoteToActiveTurn>>;
  try {
    delivery = await deliverFoldedProvenanceNoteToActiveTurn({
      sessionKey,
      note,
      deliveryTimeoutMs: policy.deliveryTimeoutMs,
    });
  } catch (err) {
    delivery = { delivered: false, reason: formatErrorMessage(err) };
  }
  return { now, retryDelayMs: policy.retryDelayMs, delivery };
}

export function commitFoldedContinuationWork(
  sessionKey: string,
  candidates: readonly ContinuationWorkFoldCandidate[],
  attempt: ContinuationWorkFoldAttempt,
): ContinuationWorkFoldExecutionResult {
  const works = candidates.map((candidate) => candidate.work);
  const { delivery, now } = attempt;
  if (!delivery.delivered) {
    const retryDueAt = now + attempt.retryDelayMs;
    const retryAfterActiveRun =
      delivery.reason === "active-embedded-run-required-for-transcript-proof" ||
      delivery.reason.startsWith("queued-without-transcript-commit:");
    const requeues: Extract<ContinuationWorkExecutionDirective, { kind: "requeued" }>[] = [];
    for (const candidate of candidates) {
      const { work } = candidate;
      const retryTrigger = retryAfterActiveRun ? ({ kind: "reply-run-ended" } as const) : undefined;
      const requeued = requeuePendingWork(work, {
        dueAt: retryDueAt,
        summary: `Continuation fold-note delivery failed (${delivery.reason}); keeping row recoverable.`,
        ...(retryAfterActiveRun
          ? {
              idleRetry: {
                trigger: "reply-run-ended",
                reasonCategory: candidate.reasonCategory,
                armedAt: now,
              },
            }
          : {}),
      });
      if (requeued) {
        requeues.push({
          kind: "requeued",
          sessionKey: work.sessionKey,
          dueAt: retryDueAt,
          ...(retryTrigger ? { retryTrigger } : {}),
        });
      }
    }
    log.warn(
      `[continuation:work-fold-note-undelivered] session=${sessionKey} count=${works.length} reason=${delivery.reason} rows kept recoverable, not terminalized`,
    );
    return { folded: 0, requeues };
  }
  let folded = 0;
  for (const work of works) {
    const overdueByMs = Math.max(0, now - work.dueAt);
    log.info(
      `[continuation:work-folded-active] flowId=${work.flowId ?? "none"} session=${sessionKey} hop=${work.hop} overdueMs=${overdueByMs} folded into active turn`,
    );
    const deliveredMark = markPendingWorkFoldDelivered(work, {
      foldedAt: delivery.deliveredAt,
      overdueByMs,
    });
    if (!deliveredMark.applied) {
      continue;
    }
    markPendingWorkFolded(deliveredMark.work, {
      summary: "matured while a later turn was active",
      foldedAt: delivery.deliveredAt,
      overdueByMs,
    });
    folded++;
  }
  return { folded, requeues: [] };
}

export async function executePendingContinuationWork(
  work: PendingContinuationWork,
  policy: ContinuationWorkExecutionPolicy,
  signal: AbortSignal,
): Promise<ContinuationWorkExecutionDirective> {
  try {
    const fireDeferredMs = Date.now() - work.electedAt;
    const fireChainId = work.chainId ?? work.flowId ?? work.sessionKey;
    const outboundTraceparent = resolveContinuationTraceparent(work.traceparent);
    emitContinuationWorkFireSpan({
      chainId: fireChainId,
      chainStepRemainingAtDispatch: Math.max(0, work.maxChainLength - work.hop),
      delayMs: work.delayMs,
      fireDeferredMs,
      reason: work.reason,
      traceparent: outboundTraceparent,
      log: (message) => log.info(message),
    });
    log.info(
      `[continuation:work-wake] hop=${work.hop}/${work.maxChainLength} session=${work.sessionKey} reasonCategory=${policy.reasonCategory}`,
    );
    const result = await driveContinuationTurn(
      work,
      formatContinuationWakeText(work),
      policy.mainCommandLane,
      signal,
    );
    if (result.status === "ran") {
      markPendingWorkTurnGranted(result.work);
      return { kind: "dispatched" };
    }
    if (result.status === "ran-finalized") {
      return { kind: "dispatched" };
    }

    const skippedReason = result.reason;
    log.warn(
      `[continuation:work-drive-skipped] flowId=${work.flowId ?? "none"} session=${work.sessionKey} reason=${skippedReason} reasonCategory=${policy.reasonCategory}`,
    );
    if (skippedReason === CONTINUATION_TURN_RESET_REASON) {
      log.info(
        `[continuation:work-drive-cancelled] flowId=${work.flowId ?? "none"} session=${work.sessionKey} reason=${skippedReason}`,
      );
      return { kind: "cancelled" };
    }
    if (skippedReason === CONTINUATION_TURN_STALE_CLAIM_REASON) {
      return { kind: "unchanged" };
    }
    if (skippedReason === CONTINUATION_TURN_NOOP_REARM_BLOCKED_REASON) {
      markPendingWorkSuperseded(
        work,
        `No-op replay guard suppressed continuation turn (${skippedReason}).`,
      );
      return { kind: "failed" };
    }
    if (isRetryableContinuationSkipReason(skippedReason)) {
      const now = Date.now();
      const parentLiveness: SubagentRunLiveness =
        work.parentRunId == null
          ? "uncertain"
          : await readChildSessionRunLiveness(work.sessionKey, {
              now,
              ...(policy.orphanReapStaleCutoffMs !== undefined
                ? { staleCutoffMs: policy.orphanReapStaleCutoffMs }
                : {}),
            });
      if (work.parentRunId != null && parentLiveness === "confident-terminal") {
        log.info(
          `[continuation:work-orphan-reaped] flowId=${work.flowId ?? "none"} session=${work.sessionKey} parentRunId=${work.parentRunId} — parent confident-terminal, can never rehydrate`,
        );
        markPendingWorkReaped(
          work,
          `Orphan continuation reaped: parent run ${work.parentRunId} is confident-terminal and can never rehydrate this flow.`,
        );
        return { kind: "reaped" };
      }
      const priorBusySkips = work.busySkipCount ?? 0;
      const retryDueAt =
        now + (result.retryTrigger ? policy.idleRetryHedgeMs : policy.busyRetryDelayMs);
      const requeued = requeuePendingWork(work, {
        dueAt: retryDueAt,
        summary: `Retryable continuation skip: ${skippedReason}`,
        busySkipCount: priorBusySkips + 1,
        ...(result.retryTrigger
          ? {
              idleRetry: {
                trigger: result.retryTrigger.kind,
                reasonCategory: policy.reasonCategory,
                armedAt: now,
              },
            }
          : {}),
      });
      return requeued
        ? {
            kind: "requeued",
            sessionKey: work.sessionKey,
            dueAt: retryDueAt,
            ...(result.retryTrigger ? { retryTrigger: result.retryTrigger } : {}),
          }
        : { kind: "unchanged" };
    }

    enqueueSystemEvent(
      `[system:continuation-warning] continue_work turn was not granted (${skippedReason}).`,
      { sessionKey: work.sessionKey, trusted: true },
    );
    markPendingWorkFailed(work, `Continuation turn was not granted: ${skippedReason}`);
    return { kind: "failed" };
  } catch (err) {
    if (signal.aborted) {
      log.info(
        `[continuation:work-drive-cancelled] flowId=${work.flowId ?? "none"} session=${work.sessionKey} reason=${CONTINUATION_TURN_RESET_REASON}`,
      );
      return { kind: "cancelled" };
    }
    const message = formatErrorMessage(err);
    const retryCount = (work.retryCount ?? 0) + 1;
    if (retryCount <= MAX_TRANSIENT_ERROR_RETRY_COUNT) {
      const retryDueAt = Date.now() + TRANSIENT_ERROR_RETRY_MS;
      log.warn(
        `[continuation:work-drive-error-retry] flowId=${work.flowId ?? "none"} session=${work.sessionKey} retry=${retryCount}/${MAX_TRANSIENT_ERROR_RETRY_COUNT} error=${message}`,
      );
      const requeued = requeuePendingWork(work, {
        dueAt: retryDueAt,
        summary: `Transient continuation turn error: ${message}`,
        retryCount,
      });
      return requeued
        ? { kind: "requeued", sessionKey: work.sessionKey, dueAt: retryDueAt }
        : { kind: "unchanged" };
    }
    // Retries are exhausted: this wake will never run. The notice obligation is
    // persisted in the SAME CAS that fails the row, so a crash before the agent
    // is told leaves the obligation readable in the store rather than lost with
    // the in-memory event queue. The CAS result stays the dedupe authority: a
    // re-entrant or recovered caller holding a stale claim loses it and reports
    // nothing.
    const terminalized = markPendingWorkFailed(work, message, {
      terminalNoticePending: "retry-exhausted",
    });
    if (terminalized) {
      log.error(
        `[continuation:work-drive-error-exhausted] flowId=${work.flowId ?? "none"} session=${work.sessionKey} hop=${work.hop} attempts=${retryCount} maxRetries=${MAX_TRANSIENT_ERROR_RETRY_COUNT} error=${message}`,
      );
      // Hand the persisted obligation to the durable delivery queue. A failure
      // arms a bounded live retry and leaves the flag set, so the outcome never
      // depends on unrelated traffic or another restart.
      await deliverPendingTerminalNoticeWithRetry(work);
    }
    return { kind: "failed" };
  }
}
