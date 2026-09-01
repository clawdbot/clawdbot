/**
 * Delivery orchestration for async exec approval follow-ups.
 * Resumes the originating agent session when possible and falls back to safe
 * direct delivery only when session resume is unavailable.
 */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { getGatewayRecoveryRuntime } from "../gateway/server-recovery-runtime-context.js";
import { emitDiagnosticEvent } from "../infra/diagnostic-events.js";
import {
  resolveExternalBestEffortDeliveryTarget,
  type ExternalBestEffortDeliveryTarget,
} from "../infra/outbound/best-effort-delivery.js";
import { sendMessage } from "../infra/outbound/message.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { stringifyRouteThreadId } from "../plugin-sdk/channel-route.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { isCronSessionKey, isSubagentSessionKey } from "../sessions/session-key-utils.js";
import { isGatewayMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import {
  buildExecApprovalFollowupIdempotencyKey,
  isExecApprovalFollowupSessionRebound,
  registerExecApprovalFollowupRuntimeHandoff,
} from "./bash-tools.exec-approval-followup-state.js";
import {
  buildExecApprovalContinuationFallbackPrompt,
  buildExecApprovalContinuationPrompt,
} from "./bash-tools.exec-approval-output.js";
import { renderUserFacingText } from "./embedded-agent-helpers/user-facing-text.js";
import {
  formatExecDeniedUserMessage,
  isExecDeniedResultText,
  parseExecApprovalResultText,
} from "./exec-approval-result.js";
import { callGatewayTool } from "./tools/gateway.js";

const log = createSubsystemLogger("agents/exec-approval-followup");
const DIRECT_FOLLOWUP_MAX_UTF16_UNITS = 4_000;
const DIRECT_FOLLOWUP_TRUNCATION_MARKER = "[... earlier command output omitted ...]";
const DIRECT_FOLLOWUP_COMPLETION_RETENTION = {
  idPrefix: "exec-approval-followup:",
  maxAgeMs: 24 * 60 * 60_000,
  maxEntries: 2_000,
} as const;
const AGENT_FOLLOWUP_RUN_TIMEOUT_SECONDS = 5 * 60;
const AGENT_FOLLOWUP_WAIT_TIMEOUT_MS = 60_000;
const AGENT_FOLLOWUP_WAIT_RETRY_DELAY_MS = 1_000;
const AGENT_FOLLOWUP_OBSERVATION_TIMEOUT_MS =
  AGENT_FOLLOWUP_RUN_TIMEOUT_SECONDS * 1_000 + AGENT_FOLLOWUP_WAIT_TIMEOUT_MS;

async function callExecApprovalFollowupGateway(
  method: "agent" | "agent.wait",
  timeoutMs: number,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const gatewayRuntime = getGatewayRecoveryRuntime();
  if (gatewayRuntime) {
    return method === "agent"
      ? await gatewayRuntime.dispatchAgent(
          params as Parameters<typeof gatewayRuntime.dispatchAgent>[0],
          timeoutMs,
        )
      : await gatewayRuntime.waitForAgent(
          params as Parameters<typeof gatewayRuntime.waitForAgent>[0],
          timeoutMs,
        );
  }
  return await callGatewayTool(method, { timeoutMs }, params);
}

type ExecApprovalFollowupParams = {
  approvalId: string;
  agentId?: string;
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
function buildExecApprovalFollowupPrompt(resultText: string): string {
  const trimmed = resultText.trim();
  if (isExecDeniedResultText(trimmed)) {
    return buildExecDeniedFollowupPrompt(trimmed);
  }
  return buildExecApprovalContinuationPrompt(resultText).message;
}

function shouldSuppressExecDeniedFollowup(sessionKey: string | undefined): boolean {
  return isSubagentSessionKey(sessionKey) || isCronSessionKey(sessionKey);
}

/**
 * Direct/denied followups bypass the gateway agent dispatch, so the gateway
 * rebind guard never sees them. Resolve the session key's current sessionId and
 * report whether it was rebound away from the approval-time session by `/new`
 * or `/reset` (#59349). Failure to resolve is treated as "not rebound" so a
 * real result is never suppressed by accident.
 */
function isExecApprovalFollowupDirectDeliveryStale(params: {
  agentId: string | undefined;
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
    const storePath = resolveSessionStorePathCore(normalizeOptionalString(params.sessionStore), {
      agentId: params.agentId ?? resolveAgentIdFromSessionKey(sessionKey),
    });
    const resolvedSessionId = normalizeOptionalString(
      loadSessionEntryReadOnly({
        agentId: params.agentId,
        storePath,
        sessionKey,
        clone: false,
      })?.sessionId,
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
    const body = redactToolPayloadText(
      renderUserFacingText(parsed.body, {
        errorContext: !metadata.includes("code 0"),
      }),
    ).trim();

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
    const body = redactToolPayloadText(
      renderUserFacingText(parsed.body, { errorContext: true }),
    ).trim();
    return body || "Background command finished.";
  }

  return (
    redactToolPayloadText(renderUserFacingText(parsed.raw, { errorContext: true })).trim() || null
  );
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

function hasTerminalFollowupEvidence(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.endedAt === "number" ||
    typeof record.error === "string" ||
    typeof record.stopReason === "string" ||
    record.livenessState === "terminal"
  );
}

async function waitForAgentFollowupRun(params: {
  runId: string;
  timeoutMs: number;
}): Promise<
  | { status: "completed" }
  | { status: "observation_ended"; reason: "deadline"; transportErrors: number }
> {
  const observationDeadline = Date.now() + AGENT_FOLLOWUP_OBSERVATION_TIMEOUT_MS;
  let consecutiveTransportErrors = 0;
  let transportErrors = 0;
  for (;;) {
    const remainingMs = observationDeadline - Date.now();
    if (remainingMs <= 0) {
      return { status: "observation_ended", reason: "deadline", transportErrors };
    }
    const waitTimeoutMs = Math.max(1, Math.min(params.timeoutMs, remainingMs));
    let wait: Record<string, unknown>;
    try {
      wait = await callExecApprovalFollowupGateway("agent.wait", waitTimeoutMs + 2_000, {
        runId: params.runId,
        timeoutMs: waitTimeoutMs,
      });
    } catch {
      // The accepted run remains the sole delivery owner. Keep observing
      // across bounded gateway reconnects instead of racing it with direct delivery.
      consecutiveTransportErrors += 1;
      transportErrors += 1;
      const retryDelayMs = Math.min(
        AGENT_FOLLOWUP_WAIT_RETRY_DELAY_MS,
        observationDeadline - Date.now(),
      );
      if (retryDelayMs <= 0) {
        return { status: "observation_ended", reason: "deadline", transportErrors };
      }
      if (consecutiveTransportErrors > 1) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, retryDelayMs);
          timer.unref?.();
        });
      }
      continue;
    }
    consecutiveTransportErrors = 0;
    const status = readGatewayStatus(wait);
    if (isSuccessfulFollowupStatus(status)) {
      return { status: "completed" };
    }
    if (hasTerminalFollowupEvidence(wait)) {
      throw buildFollowupWaitError({ status, error: wait.error });
    }
  }
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
  agentId?: string;
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
  const isDenied = isExecDeniedResultText(params.resultText.trim());
  return {
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: params.sessionKey,
    message: isDenied
      ? buildExecApprovalFollowupPrompt(params.resultText)
      : buildExecApprovalContinuationFallbackPrompt(params.resultText),
    inputProvenance: {
      kind: "inter_session" as const,
      sourceSessionKey: params.sessionKey,
      sourceTool: "exec_approval_followup",
    },
    deliver: deliveryTarget.deliver,
    ...(deliveryTarget.deliver ? { bestEffortDeliver: true as const } : {}),
    channel: deliveryTarget.deliver ? deliveryTarget.channel : fallbackChannel,
    to: deliveryTarget.deliver ? deliveryTarget.to : params.turnSourceTo,
    accountId: deliveryTarget.deliver ? deliveryTarget.accountId : params.turnSourceAccountId,
    threadId: deliveryTarget.deliver
      ? deliveryTarget.threadId
      : stringifyRouteThreadId(params.turnSourceThreadId),
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
    timeout: AGENT_FOLLOWUP_RUN_TIMEOUT_SECONDS,
  };
}

async function sendDirectFollowupFallback(params: {
  approvalId: string;
  agentId?: string;
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
  const availableBodyUnits =
    DIRECT_FOLLOWUP_MAX_UTF16_UNITS - prefix.length - DIRECT_FOLLOWUP_TRUNCATION_MARKER.length - 1;
  const content =
    `${prefix}${directText}`.length <= DIRECT_FOLLOWUP_MAX_UTF16_UNITS
      ? `${prefix}${directText}`
      : `${prefix}${DIRECT_FOLLOWUP_TRUNCATION_MARKER}\n${sliceUtf16Safe(
          directText,
          Math.max(0, directText.length - Math.max(1, availableBodyUnits)),
        )}`;
  const deliveryIntentId = `exec-approval-followup:${params.approvalId}`;
  const sendResult = await sendMessage({
    channel: params.deliveryTarget.channel,
    to: params.deliveryTarget.to ?? "",
    accountId: params.deliveryTarget.accountId,
    threadId: params.deliveryTarget.threadId,
    content,
    agentId: params.agentId,
    gatewayOwnedDelivery: true,
    idempotencyKey: deliveryIntentId,
    deliveryIntentId,
    reusePendingDeliveryIntent: true,
    completionRetention: DIRECT_FOLLOWUP_COMPLETION_RETENTION,
  });
  if (sendResult.deliveryStatus === "suppressed") {
    if (sendResult.suppressionReason === "adapter_returned_no_identity") {
      throw new Error(
        "exec approval followup delivery could not be confirmed: adapter returned no identity",
      );
    }
    throw new Error(
      `exec approval followup delivery was suppressed: ${sendResult.suppressionReason ?? "unknown reason"}`,
    );
  }
  return true;
}

/** Sends an exec approval follow-up via session resume or safe direct delivery. */
export async function sendExecApprovalFollowup(
  params: ExecApprovalFollowupParams,
): Promise<boolean> {
  const sessionKey = params.sessionKey?.trim();
  // Trimmed text only classifies empty/denied results; the raw text is what reaches the
  // agent so command whitespace survives the follow-up.
  const trimmedResultText = params.resultText.trim();
  if (!trimmedResultText) {
    return false;
  }
  const resultText = params.resultText;
  const isDenied = isExecDeniedResultText(trimmedResultText);
  let internalRuntimeHandoffId = params.internalRuntimeHandoffId;
  let idempotencyKey = params.idempotencyKey;
  if (!isDenied && sessionKey && params.direct !== true && !internalRuntimeHandoffId) {
    const runtimeHandoff = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: params.approvalId,
      sessionKey,
      resultText,
    });
    internalRuntimeHandoffId = runtimeHandoff?.handoffId;
    idempotencyKey = runtimeHandoff?.idempotencyKey;
  }

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
        agentId: params.agentId,
        sessionKey,
        expectedSessionId: params.expectedSessionId,
        resultText,
        deliveryTarget,
        sessionOnlyOriginChannel,
        turnSourceChannel: params.turnSourceChannel,
        turnSourceTo: params.turnSourceTo,
        turnSourceAccountId: params.turnSourceAccountId,
        turnSourceThreadId: params.turnSourceThreadId,
        internalRuntimeHandoffId,
        idempotencyKey,
      });
      const accepted = await callExecApprovalFollowupGateway("agent", 60_000, agentArgs);
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
        const waitResult = await waitForAgentFollowupRun({
          runId,
          timeoutMs: AGENT_FOLLOWUP_WAIT_TIMEOUT_MS,
        });
        if (waitResult.status === "observation_ended") {
          emitDiagnosticEvent({
            type: "log.record",
            level: "WARN",
            message: "Exec approval followup observation ended",
            loggerName: "agents/exec-approval-followup",
            attributes: {
              approvalId: params.approvalId,
              runId,
              reason: waitResult.reason,
              transportErrors: waitResult.transportErrors,
              deliveryOwner: "accepted_agent_run",
            },
          });
          log.warn(
            `Stopped observing accepted exec approval followup ${params.approvalId} after its bounded wait window; run ${runId} remains the sole delivery owner`,
          );
        }
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
        agentId: params.agentId,
        sessionKey,
        expectedSessionId: params.expectedSessionId,
        sessionStore: params.sessionStore,
      })
    ) {
      emitDiagnosticEvent({
        type: "exec.approval.followup_suppressed",
        approvalId: params.approvalId,
        reason: "session_rebound",
        phase: "direct_delivery",
      });
      log.info(
        `Dropping stale denied exec approval followup ${params.approvalId}: session ${sessionKey ?? ""} was rebound before the approval resolved`,
      );
      return false;
    }
    if (
      await sendDirectFollowupFallback({
        approvalId: params.approvalId,
        agentId: params.agentId,
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
      agentId: params.agentId,
      sessionKey,
      expectedSessionId: params.expectedSessionId,
      sessionStore: params.sessionStore,
    })
  ) {
    emitDiagnosticEvent({
      type: "exec.approval.followup_suppressed",
      approvalId: params.approvalId,
      reason: "session_rebound",
      phase: "direct_delivery",
    });
    log.info(
      `Dropping stale exec approval followup ${params.approvalId} direct fallback: session ${sessionKey ?? ""} was rebound before the approval resolved`,
    );
    return false;
  }

  if (
    await sendDirectFollowupFallback({
      approvalId: params.approvalId,
      agentId: params.agentId,
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
