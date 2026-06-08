/**
 * Delivery orchestration for async exec approval follow-ups.
 * Resumes the originating agent session when possible and falls back to safe
 * direct delivery only when session resume is unavailable.
 */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import {
  resolveExternalBestEffortDeliveryTarget,
  type ExternalBestEffortDeliveryTarget,
} from "../infra/outbound/best-effort-delivery.js";
import { sendMessage } from "../infra/outbound/message.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { isCronSessionKey, isSubagentSessionKey } from "../sessions/session-key-utils.js";
import { isGatewayMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import {
  buildExecApprovalFollowupIdempotencyKey,
  isExecApprovalFollowupSessionRebound,
} from "./bash-tools.exec-approval-followup-state.js";
import { sanitizeUserFacingText } from "./embedded-agent-helpers/sanitize-user-facing-text.js";
import {
  formatExecDeniedUserMessage,
  isExecDeniedResultText,
  parseExecApprovalResultText,
} from "./exec-approval-result.js";
import { callGatewayTool } from "./tools/gateway.js";

const log = createSubsystemLogger("agents/exec-approval-followup");

type ExecApprovalFollowupParams = {
  approvalId: string;
  sessionKey?: string;
  /** Session UUID active when the approval was requested. Carried to the gateway
   *  so a followup whose session key was rebound by /new or /reset is dropped. */
  expectedSessionId?: string;
  /** `session.store` template, used by the direct/denied path to resolve the
   *  key's current sessionId and drop a rebound followup before sending. */
  sessionStore?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  resultText: string;
  direct?: boolean;
  internalRuntimeHandoffId?: string;
  idempotencyKey?: string;
};

function buildExecDeniedFollowupPrompt(resultText: string): string {
  return [
    "An async command did not run.",
    "Do not run the command again.",
    "There is no new command output.",
    "Do not mention, summarize, or reuse output from any earlier run in this session.",
    "",
    "Exact completion details:",
    resultText.trim(),
    "",
    "Reply to the user in a helpful way.",
    "Explain that the command did not run and why.",
    "Do not claim there is new command output.",
  ].join("\n");
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}

/** Builds the prompt used to resume an agent after an approved async exec completes. */
export function buildExecApprovalFollowupPrompt(resultText: string): string {
  const trimmed = resultText.trim();
  if (isExecDeniedResultText(trimmed)) {
    return buildExecDeniedFollowupPrompt(trimmed);
  }
  return [
    "An async command the user already approved has completed.",
    "Do not run the command again.",
    "If the task requires more steps, continue from this result before replying to the user.",
    "Only ask the user for help if you are actually blocked.",
    "",
    "Exact completion details:",
    trimmed,
    "",
    "Continue the task if needed, then reply to the user in a helpful way.",
    "If it succeeded, share the relevant output.",
    "If it failed, explain what went wrong.",
  ].join("\n");
}

function shouldSuppressExecDeniedFollowup(sessionKey: string | undefined): boolean {
  return isSubagentSessionKey(sessionKey) || isCronSessionKey(sessionKey);
}

/**
 * Direct/denied followups bypass the gateway agent dispatch, so the gateway
 * rebind guard never sees them. Resolve the session key's current sessionId
 * from the on-disk store and report whether it was rebound away from the
 * approval-time session by `/new` or `/reset` (#59349). Failure to resolve is
 * treated as "not rebound" so a real result is never suppressed by accident.
 */
function isExecApprovalFollowupDirectDeliveryStale(params: {
  sessionKey: string | undefined;
  expectedSessionId: string | undefined;
  sessionStore: string | undefined;
}): boolean {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const expectedSessionId = normalizeOptionalString(params.expectedSessionId);
  if (!sessionKey || !expectedSessionId) {
    return false;
  }
  try {
    const storePath = resolveStorePath(normalizeOptionalString(params.sessionStore), {
      agentId: resolveAgentIdFromSessionKey(sessionKey),
    });
    const resolvedSessionId = normalizeOptionalString(
      loadSessionStore(storePath)?.[sessionKey]?.sessionId,
    );
    return isExecApprovalFollowupSessionRebound({ expectedSessionId, resolvedSessionId });
  } catch (err) {
    // Fail open: if the session store can't be resolved we deliver rather than
    // risk dropping a real followup, but log it so this rare path is observable.
    log.debug(
      `exec approval followup session-rebind check skipped for ${sessionKey}; delivering: ${formatUnknownError(err)}`,
    );
    return false;
  }
}

function formatDirectExecApprovalFollowupText(
  resultText: string,
  opts: { allowDenied?: boolean } = {},
): string | null {
  const parsed = parseExecApprovalResultText(resultText);
  if (parsed.kind === "other" && !parsed.raw) {
    return null;
  }
  if (parsed.kind === "denied") {
    return opts.allowDenied ? formatExecDeniedUserMessage(parsed.raw) : null;
  }

  if (parsed.kind === "finished") {
    const metadata = normalizeLowercaseStringOrEmpty(parsed.metadata);
    const body = sanitizeUserFacingText(parsed.body, {
      errorContext: !metadata.includes("code 0"),
    }).trim();

    let prefix = "";
    if (!body) {
      prefix = metadata.includes("code 0")
        ? "Background command finished."
        : metadata.includes("signal")
          ? "Background command stopped unexpectedly."
          : "Background command finished with an error.";
    }

    return body ? `${prefix ? `${prefix}\n\n` : ""}${body}` : prefix || null;
  }

  if (parsed.kind === "completed") {
    const body = sanitizeUserFacingText(parsed.body, { errorContext: true }).trim();
    return body || "Background command finished.";
  }

  return sanitizeUserFacingText(parsed.raw, { errorContext: true }).trim() || null;
}

function buildSessionResumeFallbackPrefix(): string {
  return "Automatic session resume failed, so sending the status directly.\n\n";
}

function readGatewayStatus(value: unknown): string | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? normalizeOptionalString((value as { status?: unknown }).status)
    : undefined;
}

function readGatewayRunId(value: unknown): string | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? normalizeOptionalString((value as { runId?: unknown }).runId)
    : undefined;
}

function buildFollowupWaitError(params: { status?: string; error?: unknown }): Error {
  const suffix =
    typeof params.error === "string" && params.error.trim()
      ? `: ${params.error.trim()}`
      : params.status
        ? `: ${params.status}`
        : "";
  return new Error(`exec approval followup session resume failed${suffix}`);
}

function isSuccessfulFollowupStatus(status: string | undefined): boolean {
  return status === "ok";
}

async function waitForAgentFollowupRun(params: {
  runId: string;
  timeoutMs: number;
}): Promise<void> {
  const wait = await callGatewayTool(
    "agent.wait",
    { timeoutMs: params.timeoutMs + 2_000 },
    {
      runId: params.runId,
      timeoutMs: params.timeoutMs,
    },
  );
  const status = readGatewayStatus(wait);
  if (isSuccessfulFollowupStatus(status)) {
    return;
  }
  throw buildFollowupWaitError({ status, error: wait.error });
}

function shouldPrefixDirectFollowupWithSessionResumeFailure(params: {
  resultText: string;
  sessionError: unknown;
}): boolean {
  if (!params.sessionError) {
    return false;
  }
  const parsed = parseExecApprovalResultText(params.resultText);
  if (parsed.kind !== "finished") {
    return true;
  }
  return !normalizeLowercaseStringOrEmpty(parsed.metadata).includes("code 0");
}

function canDirectSendDeniedFollowup(sessionError: unknown): boolean {
  return sessionError !== null;
}

function buildAgentFollowupArgs(params: {
  approvalId: string;
  sessionKey: string;
  expectedSessionId?: string;
  resultText: string;
  deliveryTarget: ExternalBestEffortDeliveryTarget;
  sessionOnlyOriginChannel?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  internalRuntimeHandoffId?: string;
  idempotencyKey?: string;
}) {
  const { deliveryTarget, sessionOnlyOriginChannel } = params;
  // When the followup run has no deliverable route and no gateway-internal channel,
  // preserve the raw turnSourceChannel so the spawned agent inherits messageProvider.
  // Without this, tools.elevated.allowFrom.<provider> checks fail with provider=null.
  const fallbackChannel = sessionOnlyOriginChannel ?? params.turnSourceChannel;
  return {
    sessionKey: params.sessionKey,
    message: buildExecApprovalFollowupPrompt(params.resultText),
    deliver: deliveryTarget.deliver,
    ...(deliveryTarget.deliver ? { bestEffortDeliver: true as const } : {}),
    channel: deliveryTarget.deliver ? deliveryTarget.channel : fallbackChannel,
    to: deliveryTarget.deliver
      ? deliveryTarget.to
      : sessionOnlyOriginChannel
        ? params.turnSourceTo
        : undefined,
    accountId: deliveryTarget.deliver
      ? deliveryTarget.accountId
      : sessionOnlyOriginChannel
        ? params.turnSourceAccountId
        : undefined,
    threadId: deliveryTarget.deliver
      ? deliveryTarget.threadId
      : sessionOnlyOriginChannel
        ? params.turnSourceThreadId
        : undefined,
    idempotencyKey:
      params.idempotencyKey ??
      buildExecApprovalFollowupIdempotencyKey({
        approvalId: params.approvalId,
      }),
    ...(params.expectedSessionId
      ? { execApprovalFollowupExpectedSessionId: params.expectedSessionId }
      : {}),
    ...(params.internalRuntimeHandoffId
      ? { internalRuntimeHandoffId: params.internalRuntimeHandoffId }
      : {}),
  };
}

async function sendDirectFollowupFallback(params: {
  approvalId: string;
  deliveryTarget: ExternalBestEffortDeliveryTarget;
  resultText: string;
  sessionError: unknown;
  allowDenied?: boolean;
}): Promise<boolean> {
  const directText = formatDirectExecApprovalFollowupText(params.resultText, {
    allowDenied: params.allowDenied ?? canDirectSendDeniedFollowup(params.sessionError),
  });
  if (!params.deliveryTarget.deliver || !directText) {
    return false;
  }

  const prefix =
    !params.allowDenied && shouldPrefixDirectFollowupWithSessionResumeFailure(params)
      ? buildSessionResumeFallbackPrefix()
      : "";
  await sendMessage({
    channel: params.deliveryTarget.channel,
    to: params.deliveryTarget.to ?? "",
    accountId: params.deliveryTarget.accountId,
    threadId: params.deliveryTarget.threadId,
    content: `${prefix}${directText}`,
    agentId: undefined,
    idempotencyKey: `exec-approval-followup:${params.approvalId}`,
  });
  return true;
}

/** Sends an exec approval follow-up via session resume or safe direct delivery. */
export async function sendExecApprovalFollowup(
  params: ExecApprovalFollowupParams,
): Promise<boolean> {
  const sessionKey = params.sessionKey?.trim();
  const resultText = params.resultText.trim();
  if (!resultText) {
    return false;
  }
  const isDenied = isExecDeniedResultText(resultText);

  const deliveryTarget = resolveExternalBestEffortDeliveryTarget({
    channel: params.turnSourceChannel,
    to: params.turnSourceTo,
    accountId: params.turnSourceAccountId,
    threadId: params.turnSourceThreadId,
  });
  const normalizedTurnSourceChannel = normalizeMessageChannel(params.turnSourceChannel);
  const sessionOnlyOriginChannel =
    normalizedTurnSourceChannel && isGatewayMessageChannel(normalizedTurnSourceChannel)
      ? normalizedTurnSourceChannel
      : undefined;

  let sessionError: unknown = null;

  if (isDenied && (!sessionKey || shouldSuppressExecDeniedFollowup(sessionKey))) {
    return false;
  }

  if (sessionKey && params.direct !== true) {
    try {
      const agentArgs = buildAgentFollowupArgs({
        approvalId: params.approvalId,
        sessionKey,
        expectedSessionId: params.expectedSessionId,
        resultText,
        deliveryTarget,
        sessionOnlyOriginChannel,
        turnSourceChannel: params.turnSourceChannel,
        turnSourceTo: params.turnSourceTo,
        turnSourceAccountId: params.turnSourceAccountId,
        turnSourceThreadId: params.turnSourceThreadId,
        internalRuntimeHandoffId: params.internalRuntimeHandoffId,
        idempotencyKey: params.idempotencyKey,
      });
      const accepted = await callGatewayTool("agent", { timeoutMs: 60_000 }, agentArgs);
      const status = readGatewayStatus(accepted);
      if (isSuccessfulFollowupStatus(status)) {
        return true;
      }
      if (status === "accepted" || status === "in_flight" || status === "pending") {
        const runId =
          readGatewayRunId(accepted) ?? normalizeOptionalString(agentArgs.idempotencyKey);
        if (!runId) {
          throw buildFollowupWaitError({ status: "missing-run-id" });
        }
        await waitForAgentFollowupRun({ runId, timeoutMs: 60_000 });
        return true;
      }
      throw buildFollowupWaitError({ status, error: accepted.error });
    } catch (err) {
      sessionError = err;
    }
  }

  if (isDenied) {
    if (
      isExecApprovalFollowupDirectDeliveryStale({
        sessionKey,
        expectedSessionId: params.expectedSessionId,
        sessionStore: params.sessionStore,
      })
    ) {
      log.info(
        `Dropping stale denied exec approval followup ${params.approvalId}: session ${sessionKey ?? ""} was rebound before the approval resolved`,
      );
      return false;
    }
    if (
      await sendDirectFollowupFallback({
        approvalId: params.approvalId,
        deliveryTarget,
        resultText,
        sessionError,
        allowDenied: true,
      })
    ) {
      return true;
    }
    if (sessionError) {
      throw new Error(`Session followup failed: ${formatUnknownError(sessionError)}`);
    }
    return false;
  }

  if (
    isExecApprovalFollowupDirectDeliveryStale({
      sessionKey,
      expectedSessionId: params.expectedSessionId,
      sessionStore: params.sessionStore,
    })
  ) {
    log.info(
      `Dropping stale exec approval followup ${params.approvalId} direct fallback: session ${sessionKey ?? ""} was rebound before the approval resolved`,
    );
    return false;
  }

  if (
    await sendDirectFollowupFallback({
      approvalId: params.approvalId,
      deliveryTarget,
      resultText,
      sessionError,
    })
  ) {
    return true;
  }

  if (sessionError) {
    throw new Error(`Session followup failed: ${formatUnknownError(sessionError)}`);
  }
  if (isDenied) {
    return false;
  }
  throw new Error("Session key or deliverable origin route is required");
}
