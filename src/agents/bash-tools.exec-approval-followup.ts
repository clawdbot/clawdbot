import {
  resolveExternalBestEffortDeliveryTarget,
  type ExternalBestEffortDeliveryTarget,
} from "../infra/outbound/best-effort-delivery.js";
import { sendMessage } from "../infra/outbound/message.js";
import { isCronSessionKey, isSubagentSessionKey } from "../sessions/session-key-utils.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { isGatewayMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import {
  formatExecDeniedUserMessage,
  isExecDeniedResultText,
  parseExecApprovalResultText,
} from "./exec-approval-result.js";
import { sanitizeUserFacingText } from "./pi-embedded-helpers/sanitize-user-facing-text.js";
import { callGatewayTool } from "./tools/gateway.js";

type ExecApprovalFollowupParams = {
  approvalId: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  resultText: string;
  direct?: boolean;
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
  resultText: string;
  deliveryTarget: ExternalBestEffortDeliveryTarget;
  sessionOnlyOriginChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
}) {
  const { deliveryTarget, sessionOnlyOriginChannel } = params;
  return {
    sessionKey: params.sessionKey,
    message: buildExecApprovalFollowupPrompt(params.resultText),
    deliver: deliveryTarget.deliver,
    ...(deliveryTarget.deliver ? { bestEffortDeliver: true as const } : {}),
    channel: deliveryTarget.deliver ? deliveryTarget.channel : sessionOnlyOriginChannel,
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
    idempotencyKey: `exec-approval-followup:${params.approvalId}`,
  };
}

async function sendDirectFollowupFallback(params: {
  approvalId: string;
  deliveryTarget: ExternalBestEffortDeliveryTarget;
  resultText: string;
  sessionError: unknown;
}): Promise<boolean> {
  const directText = formatDirectExecApprovalFollowupText(params.resultText, {
    allowDenied: canDirectSendDeniedFollowup(params.sessionError),
  });
  if (!params.deliveryTarget.deliver || !directText) {
    return false;
  }

  const prefix = shouldPrefixDirectFollowupWithSessionResumeFailure(params)
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

export async function sendExecApprovalFollowup(
  params: ExecApprovalFollowupParams,
): Promise<boolean> {
  const sessionKey = params.sessionKey?.trim();
  const resultText = params.resultText.trim();
  if (!resultText) {
    return false;
  }
  const isDenied = isExecDeniedResultText(resultText);
  if (isDenied && shouldSuppressExecDeniedFollowup(sessionKey)) {
    return false;
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

  if (sessionKey && params.direct !== true) {
    try {
      await callGatewayTool(
        "agent",
        { timeoutMs: 60_000 },
        buildAgentFollowupArgs({
          approvalId: params.approvalId,
          sessionKey,
          resultText,
          deliveryTarget,
          sessionOnlyOriginChannel,
          turnSourceTo: params.turnSourceTo,
          turnSourceAccountId: params.turnSourceAccountId,
          turnSourceThreadId: params.turnSourceThreadId,
        }),
        { expectFinal: true },
      );
      return true;
    } catch (err) {
      sessionError = err;
    }
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
