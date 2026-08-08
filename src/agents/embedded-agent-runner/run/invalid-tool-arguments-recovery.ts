import { createHash } from "node:crypto";
import type { PluginHookToolCallRejectedEvent } from "../../../plugins/hook-types.js";
import type { AfterToolCallResult, AfterToolOutcomeContext, Agent } from "../../runtime/index.js";
import type { InternalBeforeToolBatchHook } from "../../runtime/internal-hooks.js";
import { normalizeToolName as normalizeCanonicalToolName } from "../../tool-policy.js";
import type { EmbeddedAttemptSessionLockController } from "./attempt.session-lock.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const CUSTOM_TYPE = "openclaw:invalid-tool-arguments-recovery";
const MAX_STRING_LENGTH = 128;

type Validation = PluginHookToolCallRejectedEvent["validation"];
type Rejection = PluginHookToolCallRejectedEvent;
type TerminalState = "succeeded" | "blocked" | "failed";

type RecoveryEntry = {
  version: 1;
  recoveryId: string;
  state:
    | "retry_available"
    | "retry_claimed"
    | "retry_exhausted"
    | "retry_not_matched"
    | "indeterminate"
    | TerminalState;
  attempt: 1 | 2;
  turnId: string;
  toolName: string;
  toolCallId: string;
  callOrdinal: number;
  validation: Validation;
  rejection?: Rejection;
};

type TranscriptEntry = {
  type: string;
  customType?: string;
  data?: unknown;
  message?: { role?: unknown } & Partial<MessageIdentity>;
};

type SessionManager = {
  appendCustomEntry(customType: string, data?: unknown): string;
  getEntries?(): TranscriptEntry[];
  getBranch?(): TranscriptEntry[];
};

type RejectionNotifier = (event: Rejection) => Promise<void> | void;
type MessageIdentity = Pick<AfterToolOutcomeContext["assistantMessage"], "api" | "provider">;

function bounded(value: unknown, fallback = "unknown"): string {
  const normalized =
    typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").trim() : "";
  return (normalized || fallback).slice(0, MAX_STRING_LENGTH);
}

function normalizeToolName(value: string): string {
  return bounded(normalizeCanonicalToolName(value));
}

function stableTurnId(message: AfterToolOutcomeContext["assistantMessage"]): string {
  return bounded(message.turnId ?? message.responseId, "runtime-turn");
}

function toolCallOrdinal(
  message: AfterToolOutcomeContext["assistantMessage"],
  toolCall: AfterToolOutcomeContext["toolCall"],
): number {
  const calls = message.content.filter((item) => item.type === "toolCall");
  const identityIndex = calls.indexOf(toolCall);
  return identityIndex >= 0
    ? identityIndex
    : Math.max(
        0,
        calls.findIndex((item) => item.id === toolCall.id),
      );
}

function sanitizeValidation(value: unknown): Validation | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const argumentShape = record.argumentShape;
  if (
    argumentShape !== "array" &&
    argumentShape !== "boolean" &&
    argumentShape !== "null" &&
    argumentShape !== "number" &&
    argumentShape !== "object" &&
    argumentShape !== "string" &&
    argumentShape !== "undefined"
  ) {
    return undefined;
  }
  if (
    typeof record.issueCount !== "number" ||
    !Number.isSafeInteger(record.issueCount) ||
    record.issueCount < 0 ||
    !Array.isArray(record.issues) ||
    typeof record.truncated !== "boolean"
  ) {
    return undefined;
  }
  const issues: Validation["issues"] = [];
  for (const value of record.issues.slice(0, 8)) {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const issue = value as Record<string, unknown>;
    const code = issue.code;
    if (
      code !== "additionalProperties" &&
      code !== "enum" &&
      code !== "required" &&
      code !== "schema" &&
      code !== "type"
    ) {
      return undefined;
    }
    issues.push({ code, path: bounded(issue.path, "root") });
  }
  return {
    argumentShape,
    issueCount: record.issueCount,
    issues,
    truncated: record.truncated || record.issues.length > 8,
  };
}

function validationFromOutcome(context: AfterToolOutcomeContext): Validation | undefined {
  const details = context.result.details;
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const validation = (details as Record<string, unknown>).validation;
  return sanitizeValidation(validation);
}

function isTerminalRecoveryRejection(context: AfterToolOutcomeContext): boolean {
  const details = context.result.details;
  if (!details || typeof details !== "object") {
    return false;
  }
  const record = details as Record<string, unknown>;
  return (
    record.classification === "invalid_tool_arguments" &&
    record.executionStarted === false &&
    (record.reason === "retry_exhausted" ||
      record.reason === "retry_not_matched" ||
      record.reason === "retry_claimed_without_receipt")
  );
}

function parseRecoveryEntry(value: unknown): RecoveryEntry | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const state = record.state;
  const validation = sanitizeValidation(record.validation);
  if (
    record.version !== 1 ||
    typeof record.recoveryId !== "string" ||
    (state !== "retry_available" &&
      state !== "retry_claimed" &&
      state !== "retry_exhausted" &&
      state !== "retry_not_matched" &&
      state !== "indeterminate" &&
      state !== "succeeded" &&
      state !== "blocked" &&
      state !== "failed") ||
    (record.attempt !== 1 && record.attempt !== 2) ||
    typeof record.turnId !== "string" ||
    typeof record.toolName !== "string" ||
    typeof record.toolCallId !== "string" ||
    typeof record.callOrdinal !== "number" ||
    !Number.isSafeInteger(record.callOrdinal) ||
    record.callOrdinal < 0 ||
    !validation
  ) {
    return undefined;
  }
  return {
    version: 1,
    recoveryId: bounded(record.recoveryId),
    state,
    attempt: record.attempt,
    turnId: bounded(record.turnId, "runtime-turn"),
    toolName: normalizeToolName(record.toolName),
    toolCallId: bounded(record.toolCallId),
    callOrdinal: record.callOrdinal,
    validation,
  };
}

function activeTranscriptEntries(sessionManager: SessionManager): TranscriptEntry[] {
  if (typeof sessionManager.getBranch === "function") {
    return sessionManager.getBranch();
  }
  return typeof sessionManager.getEntries === "function" ? sessionManager.getEntries() : [];
}

function latestRecoveryState(sessionManager: SessionManager): {
  entry?: RecoveryEntry;
  laterAssistant?: MessageIdentity;
} {
  const entries = activeTranscriptEntries(sessionManager);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const transcriptEntry = entries[index];
    if (transcriptEntry?.type === "custom" && transcriptEntry.customType === CUSTOM_TYPE) {
      const recovery = parseRecoveryEntry(transcriptEntry.data);
      if (!recovery) {
        continue;
      }
      const laterAssistantEntry = entries
        .slice(index + 1)
        .find(
          (candidate) => candidate.type === "message" && candidate.message?.role === "assistant",
        );
      const laterAssistant = laterAssistantEntry?.message;
      return {
        entry: recovery,
        ...(laterAssistant?.api && laterAssistant.provider
          ? {
              laterAssistant: {
                api: laterAssistant.api,
                provider: laterAssistant.provider,
              },
            }
          : {}),
      };
    }
  }
  return {};
}

function createRecoveryId(params: {
  sessionId: string;
  turnId: string;
  callOrdinal: number;
  toolName: string;
}): string {
  return createHash("sha256")
    .update(
      [params.sessionId, params.turnId, String(params.callOrdinal), params.toolName].join("\u0000"),
    )
    .digest("base64url")
    .slice(0, 32);
}

function mergeOutcome(
  context: AfterToolOutcomeContext,
  prior: AfterToolCallResult | undefined,
): AfterToolOutcomeContext {
  if (!prior) {
    return context;
  }
  return {
    ...context,
    result: {
      ...context.result,
      content: prior.content ?? context.result.content,
      details: prior.details ?? context.result.details,
      terminate: prior.terminate ?? context.result.terminate,
    },
    isError: prior.isError ?? context.isError,
  };
}

function terminalState(context: AfterToolOutcomeContext): TerminalState {
  if (!context.isError) {
    return "succeeded";
  }
  return context.executionStarted ? "failed" : "blocked";
}

function correctionText(toolName: string): string {
  return `The arguments for tool "${bounded(toolName)}" did not match its schema. Emit exactly one corrected call to the same tool now. This is the only correction attempt.`;
}

function terminalText(reason: Rejection["reason"]): string {
  if (reason === "retry_exhausted") {
    return "The single tool-argument correction attempt was malformed. No further retry is allowed.";
  }
  if (reason === "retry_claimed_without_receipt") {
    return "A prior correction was claimed without a durable result receipt. It will not be executed again.";
  }
  return "The tool-argument recovery turn was not an exact single call to the intended tool. No further retry is allowed.";
}

export async function createInvalidToolArgumentsRecovery(params: {
  attempt: EmbeddedRunAttemptParams;
  sessionManager: SessionManager;
  sessionLockController: EmbeddedAttemptSessionLockController;
  notifyRejected: RejectionNotifier;
  downstreamBeforeToolBatch?: InternalBeforeToolBatchHook;
}): Promise<{
  beforeToolBatch: InternalBeforeToolBatchHook;
  install(agent: Agent): void;
}> {
  const append = async (entry: RecoveryEntry): Promise<void> => {
    await params.sessionLockController.withSessionWriteLock(() => {
      params.sessionManager.appendCustomEntry(CUSTOM_TYPE, entry);
    });
  };
  const appendIfActive = async (
    entry: RecoveryEntry,
    signal: AbortSignal | undefined,
  ): Promise<boolean> =>
    await params.sessionLockController.withSessionWriteLock(() => {
      if (signal?.aborted) {
        return false;
      }
      params.sessionManager.appendCustomEntry(CUSTOM_TYPE, entry);
      return true;
    });

  const correlation = (entry: RecoveryEntry, message: MessageIdentity) => ({
    runId: bounded(params.attempt.runId),
    sessionId: bounded(params.attempt.sessionId),
    sessionKey: bounded(params.attempt.sessionKey ?? params.attempt.sandboxSessionKey),
    turnId: bounded(entry.turnId),
    intendedTool: bounded(entry.toolName),
    providerToolCallId: bounded(entry.toolCallId),
    providerToolCallIdOrigin: "unknown" as const,
    provider: bounded(message.provider ?? params.attempt.provider),
    transport: bounded(message.api ?? params.attempt.model.api),
  });

  const rejection = (
    entry: RecoveryEntry,
    message: MessageIdentity,
    reason: Rejection["reason"],
  ): Rejection => {
    const terminal = reason !== "schema_validation_failed";
    return {
      classification: "invalid_tool_arguments",
      executionStarted: false,
      reason,
      correlation: correlation(entry, message),
      recovery: {
        recoveryId: bounded(entry.recoveryId),
        attempt: terminal ? 2 : 1,
        maxAttempts: 2,
        remainingAttempts: terminal ? 0 : 1,
        state:
          reason === "schema_validation_failed"
            ? "retry_available"
            : reason === "retry_exhausted"
              ? "retry_exhausted"
              : reason === "retry_not_matched"
                ? "retry_not_matched"
                : "indeterminate",
        ...(terminal ? { terminalReason: reason } : {}),
      },
      validation: entry.validation,
    };
  };

  let pending: RecoveryEntry | undefined;
  let claimed: RecoveryEntry | undefined;
  let claimedToolCallId: string | undefined;
  let replayIndeterminate: RecoveryEntry | undefined;
  const latestState = latestRecoveryState(params.sessionManager);
  const latest = latestState.entry;
  if (latest?.state === "retry_available") {
    if (latestState.laterAssistant) {
      const event = rejection(latest, latestState.laterAssistant, "retry_not_matched");
      await append({
        ...latest,
        state: "retry_not_matched",
        attempt: 2,
        rejection: event,
      });
      await params.notifyRejected(event);
    } else {
      pending = latest;
    }
  } else if (latest?.state === "retry_claimed") {
    const event = rejection(
      latest,
      {
        api: params.attempt.model.api,
        provider: params.attempt.provider,
      },
      "retry_claimed_without_receipt",
    );
    replayIndeterminate = {
      ...latest,
      state: "indeterminate",
      attempt: 2,
      rejection: event,
    };
    await append(replayIndeterminate);
  }

  const closePending = async (
    base: RecoveryEntry,
    message: AfterToolOutcomeContext["assistantMessage"],
    reason: "retry_exhausted" | "retry_not_matched",
  ): Promise<RecoveryEntry> => {
    const event = rejection(base, message, reason);
    const closed: RecoveryEntry = {
      ...base,
      state: reason,
      attempt: 2,
      rejection: event,
    };
    await append(closed);
    pending = undefined;
    return closed;
  };

  const beforeToolBatch: InternalBeforeToolBatchHook = async (context, signal) => {
    const batchRejections = context.rejections ?? [];
    const sourceToolCalls = context.assistantMessage.content.filter(
      (item) => item.type === "toolCall",
    );
    if (replayIndeterminate) {
      const target =
        sourceToolCalls[0] ?? context.calls[0]?.toolCall ?? batchRejections[0]?.toolCall;
      if (target) {
        return {
          intervention: {
            kind: "invalid-tool-arguments-recovery",
            toolCallId: target.id,
            toolName: target.name,
            reason: terminalText("retry_claimed_without_receipt"),
            rejection: replayIndeterminate.rejection,
          },
        };
      }
    }

    const preflightCandidates = [
      ...context.calls.map((item) => ({ ...item, rejected: false as const })),
      ...batchRejections.map((item) => ({ ...item, rejected: true as const })),
    ];
    const callsByIdentity = new Map(context.calls.map((item) => [item.toolCall, item]));
    const rejectionsByIdentity = new Map(batchRejections.map((item) => [item.toolCall, item]));
    const all =
      sourceToolCalls.length > 0
        ? sourceToolCalls.map((toolCall) => {
            const rejected = rejectionsByIdentity.get(toolCall);
            if (rejected) {
              return { ...rejected, rejected: true as const };
            }
            const admitted = callsByIdentity.get(toolCall);
            return {
              ...(admitted ?? { toolCall, args: toolCall.arguments }),
              rejected: false as const,
            };
          })
        : preflightCandidates;
    if (pending) {
      const candidate = all[0];
      const matched =
        all.length === 1 &&
        candidate !== undefined &&
        normalizeToolName(candidate.toolCall.name) === normalizeToolName(pending.toolName);
      if (!matched || !candidate) {
        const closed = await closePending(pending, context.assistantMessage, "retry_not_matched");
        const target = candidate?.toolCall ?? pending;
        return {
          intervention: {
            kind: "invalid-tool-arguments-recovery",
            toolCallId: "id" in target ? target.id : target.toolCallId,
            toolName: "name" in target ? target.name : target.toolName,
            reason: terminalText("retry_not_matched"),
            rejection: closed.rejection,
          },
        };
      }
      if (candidate.rejected) {
        const correctionEvidence: RecoveryEntry = {
          ...pending,
          turnId: stableTurnId(context.assistantMessage),
          toolCallId: bounded(candidate.toolCall.id),
          callOrdinal: toolCallOrdinal(context.assistantMessage, candidate.toolCall),
          validation: candidate.validation,
        };
        const closed = await closePending(
          correctionEvidence,
          context.assistantMessage,
          "retry_exhausted",
        );
        return {
          intervention: {
            kind: "invalid-tool-arguments-recovery",
            toolCallId: candidate.toolCall.id,
            toolName: candidate.toolCall.name,
            reason: terminalText("retry_exhausted"),
            rejection: closed.rejection,
          },
        };
      }
      claimed = {
        ...pending,
        state: "retry_claimed",
        attempt: 2,
        toolCallId: bounded(candidate.toolCall.id),
      };
      claimedToolCallId = candidate.toolCall.id;
      await append(claimed);
      pending = undefined;
    } else if (batchRejections.length > 0 && all.length > 1) {
      const first = batchRejections[0]!;
      const turnId = bounded(
        context.assistantMessage.turnId ?? context.assistantMessage.responseId,
      );
      const toolName = normalizeToolName(first.toolCall.name);
      const callOrdinal = toolCallOrdinal(context.assistantMessage, first.toolCall);
      const opened: RecoveryEntry = {
        version: 1,
        recoveryId: createRecoveryId({
          sessionId: bounded(params.attempt.sessionId),
          turnId,
          callOrdinal,
          toolName,
        }),
        state: "retry_available",
        attempt: 1,
        turnId,
        toolName,
        toolCallId: bounded(first.toolCall.id),
        callOrdinal,
        validation: first.validation,
      };
      const event = rejection(opened, context.assistantMessage, "schema_validation_failed");
      const offered = { ...opened, rejection: event };
      await append(offered);
      pending = offered;
      return {
        intervention: {
          kind: "invalid-tool-arguments-recovery",
          toolCallId: first.toolCall.id,
          toolName: first.toolCall.name,
          reason: correctionText(first.toolCall.name),
          rejection: event,
          continueRecovery: true,
        },
      };
    }

    return context.calls.length > 0
      ? await params.downstreamBeforeToolBatch?.(context, signal)
      : undefined;
  };

  const install = (agent: Agent): void => {
    const previousAfterToolOutcome = agent.afterToolOutcome?.bind(agent);
    const previousPrepareNextTurnWithContext = agent.prepareNextTurnWithContext?.bind(agent);

    agent.afterToolOutcome = async (context, signal) => {
      if (context.errorKind === "argument-validation" && !context.executionStarted) {
        if (signal?.aborted) {
          return await previousAfterToolOutcome?.(context, signal);
        }
        if (isTerminalRecoveryRejection(context)) {
          // This result closes an existing chain. Do not expose it to another
          // repair owner or reinterpret it as a fresh first rejection.
          return undefined;
        }
        const validation = validationFromOutcome(context);
        if (!validation) {
          return undefined;
        }
        const callOrdinal = toolCallOrdinal(context.assistantMessage, context.toolCall);
        const turnId = stableTurnId(context.assistantMessage);
        const toolName = normalizeToolName(context.toolCall.name);
        const opened: RecoveryEntry = {
          version: 1,
          recoveryId: createRecoveryId({
            sessionId: bounded(params.attempt.sessionId),
            turnId,
            callOrdinal,
            toolName,
          }),
          state: "retry_available",
          attempt: 1,
          turnId,
          toolName,
          toolCallId: bounded(context.toolCall.id),
          callOrdinal,
          validation,
        };
        const event = rejection(opened, context.assistantMessage, "schema_validation_failed");
        const offered = { ...opened, rejection: event };
        const alreadyOffered = pending?.recoveryId === offered.recoveryId;
        if (!alreadyOffered) {
          if (!(await appendIfActive(offered, signal))) {
            return await previousAfterToolOutcome?.(context, signal);
          }
          pending = offered;
        }
        const activeEvent = pending?.rejection ?? event;
        return {
          content: [{ type: "text", text: correctionText(context.toolCall.name) }],
          details: activeEvent,
          isError: true,
          terminate: false,
        };
      }
      const prior = await previousAfterToolOutcome?.(context, signal);
      const effective = mergeOutcome(context, prior);
      if (claimed && context.toolCall.id === claimedToolCallId) {
        const receipt: RecoveryEntry = {
          ...claimed,
          state: terminalState(effective),
          attempt: 2,
        };
        await append(receipt);
        claimed = undefined;
        claimedToolCallId = undefined;
        return prior;
      }
      return prior;
    };

    agent.prepareNextTurnWithContext = async (context, signal) => {
      if (pending && stableTurnId(context.message) !== pending.turnId) {
        const closed = await closePending(pending, context.message, "retry_not_matched");
        if (closed.rejection) {
          await params.notifyRejected(closed.rejection);
        }
      }
      return await previousPrepareNextTurnWithContext?.(context, signal);
    };
  };

  return { beforeToolBatch, install };
}
