import { performance } from "node:perf_hooks";
import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
  type GatewayClientInfo,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  formatValidationErrors,
  validateChatSendParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type {
  ChatSendIntent,
  QueueMode,
} from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { isBtwRequestText } from "../../auto-reply/reply/btw-command.js";
import type { SessionGoalOperation } from "../../config/sessions/goals-operations.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { normalizeInputProvenance } from "../../sessions/input-provenance.js";
import { isBrowserCopilotClient, isOperatorUiClient } from "../../utils/message-channel.js";
import { isChatStopCommandText } from "../chat-abort.js";
import type { ChatAttachment } from "../chat-attachments.js";
import { sanitizeChatSendMessageInput } from "../chat-input-sanitize.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize.js";
import {
  hasGatewayAdminScope,
  normalizeExplicitChatSendOrigin,
  normalizeOptionalChatSystemReceipt,
  type ChatSendExplicitOrigin,
} from "./chat-origin-routing.js";
import { resolveControlUiReconnectResumeParams } from "./chat-server-timing.js";
import { fingerprintSessionGoalRequest } from "./session-goal-request.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type ChatSendRequestParams = {
  sessionKey: string;
  agentId?: string;
  sessionId?: string;
  message: string;
  intent?: ChatSendIntent;
  thinking?: string;
  fastMode?: FastMode;
  fastAutoOnSeconds?: number;
  queueMode?: QueueMode;
  deliver?: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  originatingAccountId?: string;
  originatingThreadId?: string;
  replyToId?: string;
  attachments?: Array<{
    type?: string;
    mimeType?: string;
    fileName?: string;
    content?: unknown;
  }>;
  toolBindings?: Record<string, unknown>;
  timeoutMs?: number;
  systemInputProvenance?: InputProvenance;
  systemProvenanceReceipt?: string;
  suppressCommandInterpretation?: boolean;
  expectedLeafEntryId?: string | null;
  expectedSessionRoutingContract?: string;
  idempotencyKey: string;
};

export type NormalizedChatSendRequest = {
  goalOperation?: SessionGoalOperation & { action: "start" | "resume" };
  chatSendReceivedAtMs: number;
  clientInfo?: GatewayClientInfo;
  supportsTaskSuggestions: boolean;
  p: ChatSendRequestParams;
  explicitOrigin?: ChatSendExplicitOrigin;
  inboundMessage: string;
  systemInputProvenance?: InputProvenance;
  systemProvenanceReceipt?: string;
  suppressCommandInterpretation: boolean;
  toolBindings?: Readonly<Record<string, unknown>>;
  stopCommand: boolean;
  turnKind: "btw" | "main";
  normalizedAttachments: ChatAttachment[];
  rawMessage: string;
  reconnectResumeRequested: boolean;
};

type NormalizeChatSendRequestResult =
  | { ok: true; value: NormalizedChatSendRequest }
  | { ok: false; error: string; reason?: string };

/** Validate and normalize the wire request before session or lifecycle work begins. */
export function normalizeChatSendRequest(params: {
  params: Record<string, unknown>;
  client: GatewayRequestHandlerOptions["client"];
  trustedSystemInput?: boolean;
  goalResume?: SessionGoalOperation & { action: "resume" };
}): NormalizeChatSendRequestResult {
  const chatSendReceivedAtMs = performance.now();
  const client = params.client;
  const clientInfo = client?.connect?.client;
  const supportsTaskSuggestions =
    isOperatorUiClient(clientInfo) &&
    params.client?.connect?.scopes?.includes("operator.admin") === true &&
    hasGatewayClientCap(params.client?.connect?.caps, GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS);
  const controlUiReconnectResume = resolveControlUiReconnectResumeParams(params.params, clientInfo);
  if (!validateChatSendParams(controlUiReconnectResume.params)) {
    return {
      ok: false,
      error: `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`,
    };
  }

  const p = controlUiReconnectResume.params as ChatSendRequestParams;
  const suppressCommandInterpretation = p.suppressCommandInterpretation === true;
  const explicitOriginResult = normalizeExplicitChatSendOrigin({
    originatingChannel: p.originatingChannel,
    originatingTo: p.originatingTo,
    accountId: p.originatingAccountId,
    messageThreadId: p.originatingThreadId,
  });
  if (!explicitOriginResult.ok) {
    return explicitOriginResult;
  }
  if (
    (p.systemInputProvenance ||
      p.systemProvenanceReceipt ||
      suppressCommandInterpretation ||
      explicitOriginResult.value) &&
    !params.trustedSystemInput &&
    !hasGatewayAdminScope(params.client)
  ) {
    return {
      ok: false,
      error:
        p.systemInputProvenance || p.systemProvenanceReceipt || suppressCommandInterpretation
          ? "system provenance fields require admin scope"
          : "originating route fields require admin scope",
    };
  }

  const sanitizedMessageResult = sanitizeChatSendMessageInput(p.message);
  if (!sanitizedMessageResult.ok) {
    return sanitizedMessageResult;
  }
  if (
    p.intent &&
    (!p.message.trim() ||
      p.message.length > 16_000 ||
      p.idempotencyKey.length > 128 ||
      p.queueMode !== undefined ||
      p.systemInputProvenance !== undefined ||
      p.systemProvenanceReceipt !== undefined ||
      p.suppressCommandInterpretation !== undefined ||
      sanitizedMessageResult.message !== p.message.normalize("NFC"))
  ) {
    return {
      ok: false,
      error:
        "Goal start requires a nonempty objective of at most 16000 characters, without queue or system-input options.",
    };
  }
  if (
    p.intent &&
    (explicitOriginResult.value !== undefined ||
      p.deliver === true ||
      p.toolBindings !== undefined ||
      p.thinking !== undefined ||
      p.fastMode !== undefined ||
      p.fastAutoOnSeconds !== undefined ||
      p.timeoutMs !== undefined ||
      controlUiReconnectResume.resumeRequested)
  ) {
    // Recovery reads the persisted input and session settings, not transient run overrides.
    return {
      ok: false,
      error:
        "Goal start uses the session settings and local delivery; per-request runtime or routing overrides are not supported.",
    };
  }
  const systemReceiptResult = normalizeOptionalChatSystemReceipt(p.systemProvenanceReceipt);
  if (!systemReceiptResult.ok) {
    return systemReceiptResult;
  }

  const goalOperation =
    params.goalResume ??
    (p.intent
      ? {
          action: "start" as const,
          operationId: p.idempotencyKey,
          issuedAtMs: p.intent.issuedAtMs,
          objective: p.message,
          requestFingerprint: fingerprintSessionGoalRequest([p, hasGatewayAdminScope(client)]),
        }
      : undefined);
  const commandInterpretationSuppressed =
    suppressCommandInterpretation || goalOperation !== undefined;
  const inboundMessage = p.intent ? p.message : sanitizedMessageResult.message;
  const systemInputProvenance = params.goalResume
    ? { kind: "internal_system" as const, sourceTool: "session_goal_resume" }
    : normalizeInputProvenance(p.systemInputProvenance);
  const systemProvenanceReceipt = systemReceiptResult.receipt;
  const stopCommand = !commandInterpretationSuppressed && isChatStopCommandText(inboundMessage);
  if (p.toolBindings) {
    if (
      !client ||
      !isBrowserCopilotClient(clientInfo) ||
      client.pairedClientId !== clientInfo?.id
    ) {
      return { ok: false, error: "run tool bindings require a paired browser copilot" };
    }
    if (!hasGatewayClientCap(client.connect.caps, GATEWAY_CLIENT_CAPS.RUN_TOOL_BINDINGS)) {
      return { ok: false, error: "run tool bindings require client capability" };
    }
  }
  if (
    isBrowserCopilotClient(clientInfo) &&
    !stopCommand &&
    (!p.toolBindings || !Object.hasOwn(p.toolBindings, "browser"))
  ) {
    return { ok: false, error: "browser copilot runs require an explicit browser tool binding" };
  }
  // The browser plugin owns the binding schema and validates it while tools are
  // constructed, before model execution. Gateway owns only paired-client admission.
  const turnKind =
    !commandInterpretationSuppressed && isBtwRequestText(inboundMessage) ? "btw" : "main";
  const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(p.attachments);
  const rawMessage = goalOperation ? inboundMessage : inboundMessage.trim();
  if (!rawMessage && normalizedAttachments.length === 0) {
    return { ok: false, error: "message or attachment required" };
  }

  return {
    ok: true,
    value: {
      chatSendReceivedAtMs,
      clientInfo,
      supportsTaskSuggestions,
      p,
      ...(goalOperation ? { goalOperation } : {}),
      explicitOrigin: explicitOriginResult.value,
      inboundMessage,
      systemInputProvenance,
      systemProvenanceReceipt,
      suppressCommandInterpretation: commandInterpretationSuppressed,
      toolBindings: p.toolBindings,
      stopCommand,
      turnKind,
      normalizedAttachments,
      rawMessage,
      reconnectResumeRequested: controlUiReconnectResume.resumeRequested,
    },
  };
}
