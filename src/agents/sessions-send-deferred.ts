/** Origin-bound deferred completion for opt-in sessions_send calls. */
import crypto from "node:crypto";
import {
  findTranscriptEvent,
  loadSessionEntry,
  type TranscriptEvent,
} from "../config/sessions/session-accessor.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { buildRunUserTurnIdempotencyKey } from "../sessions/user-turn-transcript.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  type DeliveryContext,
  normalizeDeliveryContext,
} from "../utils/delivery-context.shared.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isInternalNonDeliveryChannel,
} from "../utils/message-channel.js";
import { extractAgentCommandReply } from "./agent-command-reply.js";
import type { AgentRunTerminalOutcome } from "./agent-run-terminal-outcome.js";
import { resolveNestedAgentLaneForSession } from "./lanes.js";
import {
  cancelSessionsSendDeferredCompletion,
  claimSessionsSendDeferredCompletion,
  finishSessionsSendDeferredCompletion,
  finishSessionsSendDeferredContinuation,
  listDispatchableSessionsSendDeferredRunIds,
  listOpenSessionsSendDeferredContinuationRunIds,
  listOpenSessionsSendDeferredRunIds,
  prepareSessionsSendDeferredCompletion as prepareSessionsSendDeferredCompletionStore,
  registerSessionsSendDeferredCompletion,
  type PreparedSessionsSendDeferredRegistration,
  type SessionsSendDeferredRegistration,
} from "./sessions-send-deferred-store.js";

export const SESSIONS_SEND_DEFERRED_TTL_MS = 24 * 60 * 60_000;

const openRunIds = new Set<string>();
const openContinuationRunIds = new Set<string>();
let openRunIdsLoaded = false;

type DeferredCompletionDispatch = (params: Record<string, unknown>) => Promise<unknown>;

async function dispatchContinuation(params: Record<string, unknown>): Promise<unknown> {
  const { callGateway } = await import("../gateway/call.js");
  return await callGateway({ method: "agent", params, timeoutMs: 10_000 });
}

function resolveExplicitOrigin(origin?: DeliveryContext): DeliveryContext | undefined {
  const normalized = normalizeDeliveryContext(origin);
  if (
    !normalized?.channel ||
    !normalized.to ||
    !normalized.accountId ||
    isInternalNonDeliveryChannel(normalized.channel)
  ) {
    return undefined;
  }
  return normalized;
}

/** Persist and index a one-shot deferred completion before target dispatch. */
export function armSessionsSendDeferredCompletion(
  params: {
    targetRunId: string;
    targetSessionKey: string;
    requesterSessionKey: string;
    requesterSessionId: string;
    requesterOrigin: DeliveryContext;
    requestMessage: string;
    now?: number;
    ttlMs?: number;
  },
  options: OpenClawStateDatabaseOptions = {},
): { expiresAt: number } {
  const requesterOrigin = resolveExplicitOrigin(params.requesterOrigin);
  if (!requesterOrigin) {
    throw new Error(
      "wakeOnReply requires an explicit external requester delivery context with accountId",
    );
  }
  const createdAt = params.now ?? Date.now();
  const expiresAt = createdAt + (params.ttlMs ?? SESSIONS_SEND_DEFERRED_TTL_MS);
  const registration: SessionsSendDeferredRegistration = {
    targetRunId: params.targetRunId,
    targetSessionKey: params.targetSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    requesterSessionId: params.requesterSessionId,
    requesterOrigin,
    requestMessage: params.requestMessage,
    continuationRunId: crypto.randomUUID(),
    createdAt,
    expiresAt,
  };
  registerSessionsSendDeferredCompletion(registration, options);
  openRunIds.add(params.targetRunId);
  openContinuationRunIds.add(registration.continuationRunId);
  return { expiresAt };
}

/** Cancel a registration when its target run was not accepted. */
export function disarmSessionsSendDeferredCompletion(
  params: { targetRunId: string; error?: string },
  options: OpenClawStateDatabaseOptions = {},
): void {
  openRunIds.delete(params.targetRunId);
  cancelSessionsSendDeferredCompletion(params, options);
}

function buildTargetCompletionText(params: {
  terminalOutcome: AgentRunTerminalOutcome;
  result?: unknown;
}): string {
  const reply = extractAgentCommandReply(params.result);
  const outcome =
    params.terminalOutcome.status === "ok"
      ? reply || "(The target run completed without final assistant text.)"
      : [
          `The target run ended with ${params.terminalOutcome.reason}.`,
          params.terminalOutcome.error,
        ]
          .filter(Boolean)
          .join(" ");
  return outcome;
}

function buildDeferredCompletionPrompt(params: {
  registration: SessionsSendDeferredRegistration & { completionText: string };
}): string {
  return [
    "[Deferred sessions_send completion]",
    `Target session: ${params.registration.targetSessionKey}`,
    `Target run: ${params.registration.targetRunId}`,
    `Original request: ${params.registration.requestMessage}`,
    "",
    "The user is waiting in this conversation for the result. Continue this conversation now and give the user the result or failure status.",
    "",
    "Target result:",
    params.registration.completionText,
  ].join("\n");
}

function buildContinuationParams(params: {
  registration: SessionsSendDeferredRegistration & { completionText: string };
}): Record<string, unknown> {
  const { registration } = params;
  const origin = registration.requesterOrigin;
  return {
    message: buildDeferredCompletionPrompt(params),
    sessionKey: registration.requesterSessionKey,
    expectedExistingSessionId: registration.requesterSessionId,
    idempotencyKey: registration.continuationRunId,
    deliver: true,
    bestEffortDeliver: false,
    sourceReplyDeliveryMode: "automatic",
    channel: origin.channel,
    to: origin.to,
    accountId: origin.accountId,
    ...(origin.threadId != null ? { threadId: String(origin.threadId) } : {}),
    lane: resolveNestedAgentLaneForSession(registration.requesterSessionKey),
    inputProvenance: {
      kind: "inter_session",
      sourceSessionKey: registration.targetSessionKey,
      sourceChannel: INTERNAL_MESSAGE_CHANNEL,
      sourceTool: "sessions_send",
    },
  };
}

function ensureOpenRunIdsLoaded(options: OpenClawStateDatabaseOptions): void {
  if (openRunIdsLoaded) {
    return;
  }
  for (const runId of listOpenSessionsSendDeferredRunIds(options)) {
    openRunIds.add(runId);
  }
  for (const runId of listOpenSessionsSendDeferredContinuationRunIds(options)) {
    openContinuationRunIds.add(runId);
  }
  openRunIdsLoaded = true;
}

function readTranscriptMessageIdempotencyKey(event: TranscriptEvent): string | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const message = (event as { message?: unknown }).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const idempotencyKey = (message as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof idempotencyKey === "string" ? idempotencyKey : undefined;
}

async function hasDurableContinuationTurn(
  registration: PreparedSessionsSendDeferredRegistration,
  options: OpenClawStateDatabaseOptions,
): Promise<boolean> {
  const entry = loadSessionEntry({
    agentId: resolveAgentIdFromSessionKey(registration.requesterSessionKey),
    env: options.env,
    sessionKey: registration.requesterSessionKey,
  });
  const ownsContinuation =
    entry?.sessionId === registration.requesterSessionId &&
    (entry.restartRecoveryDeliveryRunId === registration.continuationRunId ||
      entry.restartRecoveryTerminalRunIds?.includes(registration.continuationRunId) === true);
  if (!ownsContinuation) {
    return false;
  }
  const idempotencyKeys = new Set([
    buildRunUserTurnIdempotencyKey(registration.continuationRunId),
    `hook-block:before_agent_run:user:${registration.continuationRunId}`,
  ]);
  const match = await findTranscriptEvent(
    {
      agentId: resolveAgentIdFromSessionKey(registration.requesterSessionKey),
      env: options.env,
      sessionId: registration.requesterSessionId,
      sessionKey: registration.requesterSessionKey,
    },
    (event) => idempotencyKeys.has(readTranscriptMessageIdempotencyKey(event) ?? ""),
  );
  return match !== undefined;
}

/** Retire a deferred row only after its continuation user turn is durable. */
export function finishSessionsSendDeferredContinuationAfterTranscript(
  continuationRunId: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  ensureOpenRunIdsLoaded(options);
  if (!openContinuationRunIds.has(continuationRunId)) {
    return false;
  }
  const targetRunId = finishSessionsSendDeferredContinuation({ continuationRunId }, options);
  if (!targetRunId) {
    return false;
  }
  openContinuationRunIds.delete(continuationRunId);
  openRunIds.delete(targetRunId);
  return true;
}

/** Persist the target result before its run is allowed to settle. */
export function prepareSessionsSendDeferredCompletion(
  params: {
    targetRunId: string;
    targetSessionKey: string;
    terminalOutcome: AgentRunTerminalOutcome;
    result?: unknown;
  },
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  ensureOpenRunIdsLoaded(options);
  if (!openRunIds.has(params.targetRunId)) {
    return false;
  }
  return prepareSessionsSendDeferredCompletionStore(
    {
      targetRunId: params.targetRunId,
      targetSessionKey: params.targetSessionKey,
      terminalOutcome: params.terminalOutcome,
      completionText: buildTargetCompletionText(params),
    },
    options,
  );
}

/** Dispatch prepared work using the registration's stable idempotency key. */
export async function dispatchPreparedSessionsSendDeferredCompletion(
  params: {
    targetRunId: string;
    targetSessionKey?: string;
    dispatch?: DeferredCompletionDispatch;
  },
  options: OpenClawStateDatabaseOptions = {},
): Promise<boolean> {
  ensureOpenRunIdsLoaded(options);
  if (!openRunIds.has(params.targetRunId)) {
    return false;
  }
  const registration = claimSessionsSendDeferredCompletion(
    {
      targetRunId: params.targetRunId,
      targetSessionKey: params.targetSessionKey,
    },
    options,
  );
  if (!registration) {
    return false;
  }
  openRunIds.delete(params.targetRunId);
  try {
    if (await hasDurableContinuationTurn(registration, options)) {
      finishSessionsSendDeferredContinuationAfterTranscript(
        registration.continuationRunId,
        options,
      );
      return true;
    }
    await (params.dispatch ?? dispatchContinuation)(buildContinuationParams({ registration }));
    return true;
  } catch (error) {
    finishSessionsSendDeferredCompletion(
      {
        targetRunId: params.targetRunId,
        delivered: false,
        error: error instanceof Error ? error.message : String(error),
      },
      options,
    );
    return false;
  }
}

/** Persist and dispatch a correlated target result in the normal terminal path. */
export async function maybeCompleteSessionsSendDeferred(
  params: {
    targetRunId: string;
    targetSessionKey: string;
    terminalOutcome: AgentRunTerminalOutcome;
    result?: unknown;
    dispatch?: DeferredCompletionDispatch;
  },
  options: OpenClawStateDatabaseOptions = {},
): Promise<boolean> {
  if (!prepareSessionsSendDeferredCompletion(params, options)) {
    return false;
  }
  return await dispatchPreparedSessionsSendDeferredCompletion(params, options);
}

/** Replay prepared or interrupted continuation dispatches after gateway restart. */
export async function recoverSessionsSendDeferredCompletions(
  params: { dispatch?: DeferredCompletionDispatch } = {},
  options: OpenClawStateDatabaseOptions = {},
): Promise<{ recovered: number; failed: number }> {
  ensureOpenRunIdsLoaded(options);
  let recovered = 0;
  let failed = 0;
  for (const targetRunId of listDispatchableSessionsSendDeferredRunIds(options)) {
    const delivered = await dispatchPreparedSessionsSendDeferredCompletion(
      { targetRunId, dispatch: params.dispatch },
      options,
    );
    if (delivered) {
      recovered += 1;
    } else {
      failed += 1;
    }
  }
  return { recovered, failed };
}

export const testing = {
  resetPendingRunIds() {
    openRunIds.clear();
    openContinuationRunIds.clear();
    openRunIdsLoaded = false;
  },
};
