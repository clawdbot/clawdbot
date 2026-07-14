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
import { isBtwRequestText } from "../../auto-reply/reply/btw-command.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { normalizeInputProvenance } from "../../sessions/input-provenance.js";
import { isOperatorUiClient } from "../../utils/message-channel.js";
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
import type { GatewayRequestHandlerOptions } from "./types.js";

type ChatSendRequestParams = {
  sessionKey: string;
  agentId?: string;
  sessionId?: string;
  message: string;
  thinking?: string;
  fastMode?: FastMode;
  fastAutoOnSeconds?: number;
  deliver?: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  originatingAccountId?: string;
  originatingThreadId?: string;
  attachments?: Array<{
    type?: string;
    mimeType?: string;
    fileName?: string;
    content?: unknown;
  }>;
  timeoutMs?: number;
  systemInputProvenance?: InputProvenance;
  systemProvenanceReceipt?: string;
  suppressCommandInterpretation?: boolean;
  expectedSessionRoutingContract?: string;
  idempotencyKey: string;
};

export type NormalizedChatSendRequest = {
  chatSendReceivedAtMs: number;
  clientInfo?: GatewayClientInfo;
  supportsTaskSuggestions: boolean;
  p: ChatSendRequestParams;
  explicitOrigin?: ChatSendExplicitOrigin;
  inboundMessage: string;
  systemInputProvenance?: InputProvenance;
  systemProvenanceReceipt?: string;
  suppressCommandInterpretation: boolean;
  stopCommand: boolean;
  turnKind: "btw" | "main";
  normalizedAttachments: ChatAttachment[];
  rawMessage: string;
  reconnectResumeRequested: boolean;
};

type NormalizeChatSendRequestResult =
  | { ok: true; value: NormalizedChatSendRequest }
  | { ok: false; error: string };

/** Validate and normalize the wire request before session or lifecycle work begins. */
export function normalizeChatSendRequest(params: {
  params: Record<string, unknown>;
  client: GatewayRequestHandlerOptions["client"];
}): NormalizeChatSendRequestResult {
  const chatSendReceivedAtMs = performance.now();
  const clientInfo = params.client?.connect?.client;
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
  const systemReceiptResult = normalizeOptionalChatSystemReceipt(p.systemProvenanceReceipt);
  if (!systemReceiptResult.ok) {
    return systemReceiptResult;
  }

  const inboundMessage = sanitizedMessageResult.message;
  const systemInputProvenance = normalizeInputProvenance(p.systemInputProvenance);
  const systemProvenanceReceipt = systemReceiptResult.receipt;
  const stopCommand = !suppressCommandInterpretation && isChatStopCommandText(inboundMessage);
  const turnKind =
    !suppressCommandInterpretation && isBtwRequestText(inboundMessage) ? "btw" : "main";
  const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(p.attachments);
  const rawMessage = inboundMessage.trim();
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
      explicitOrigin: explicitOriginResult.value,
      inboundMessage,
      systemInputProvenance,
      systemProvenanceReceipt,
      suppressCommandInterpretation,
      stopCommand,
      turnKind,
      normalizedAttachments,
      rawMessage,
      reconnectResumeRequested: controlUiReconnectResume.resumeRequested,
    },
  };
}
