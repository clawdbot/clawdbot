import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AgentToolResult } from "../../agents/runtime/index.js";
import type { ExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import type { DurableMessageSendIntent } from "../../channels/message/types.js";
import type { ConversationReadInvocationOrigin } from "../../channels/plugins/conversation-read-origin.js";
import type {
  ChannelId,
  ChannelMessageActionName,
  ChannelPlugin,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import type { InternalChannelThreadingToolContext } from "../../channels/threading-tool-context-internal.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import type { GatewayClientMode, GatewayClientName } from "../../utils/message-channel.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import type { OutboundSendDeps } from "./deliver.js";
import type { DurableDeliveryCompletion } from "./delivery-completion.js";
import type { MessageBroadcastAccountPlan } from "./message-account-selection.js";
import type { MessageActionDeniedError } from "./message-action-denial.js";
import type { MessagePollResult, MessageSendResult } from "./message.js";
import type { OutboundMirror } from "./mirror.js";
import type { ResolvedMessagingTarget } from "./target-resolver.js";

export type MessageActionGateway = {
  url?: string;
  token?: string;
  timeoutMs?: number;
  resolveAgentRuntimeIdentityToken?: (context?: {
    sourceReplyFinal?: boolean;
    sourceReplyToolCallId?: string;
  }) => Promise<string | undefined>;
  terminalSourceReplyReceiptOwner?: "caller";
  clientName: GatewayClientName;
  clientDisplayName?: string;
  mode: GatewayClientMode;
};

export type MessageActionInput = {
  cfg: OpenClawConfig;
  action: ChannelMessageActionName;
  params: Record<string, unknown>;
  /** @internal Identifies model-authored calls for lossy input normalization. */
  actionOrigin?: "message-tool";
  defaultAccountId?: string;
  requesterAccountId?: string | null;
  requesterSenderId?: string | null;
  requesterSenderName?: string | null;
  requesterSenderUsername?: string | null;
  requesterSenderE164?: string | null;
  senderIsOwner?: boolean;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  workspaceDir?: string;
  /** @internal Host-owned route plan computed before broadcast SecretRef resolution. */
  broadcastAccountPlan?: MessageBroadcastAccountPlan;
  /**
   * Authorization facts resolved from the host-issued current-turn capability.
   * Presence means ambient routing fields must not be used as identity.
   */
  messageActionAuthorization?: {
    requesterAccountId?: string;
    requesterSenderId?: string;
    toolContext?: InternalChannelThreadingToolContext;
  };
  sessionId?: string;
  /** @internal Admitted run correlation carried into owner-native delivery audit. */
  runId?: string;
  /** @internal Exact admitted execution provenance for owner-native delivery audit. */
  executionIdentityToken?: ExecutionIdentityAdmissionToken;
  toolContext?: ChannelThreadingToolContext;
  /** @internal Host media grant captured before untrusted caller code can mutate config. */
  mediaAccess?: OutboundMediaAccess;
  /** @internal Workspace transport reader whose use remains subject to sender policy. */
  workspaceMediaAccess?: OutboundMediaAccess;
  gateway?: MessageActionGateway;
  deps?: OutboundSendDeps;
  sessionKey?: string;
  /** @internal Durable session key for source-reply transcript and receipt state. */
  sourceReplySessionKey?: string;
  agentId?: string;
  /** Caller owns durable outbound context and must avoid the generic delivery mirror. */
  suppressTranscriptMirror?: boolean;
  /** @internal Explicit durable transcript destination owned by the caller. */
  transcriptMirror?: OutboundMirror;
  /** @internal Channel-valid id reserved before a correlated conversation turn is sent. */
  preparedMessageId?: string;
  /** @internal The Gateway owns this call and may use its active gateway-mode adapter directly. */
  gatewayOwnedDelivery?: boolean;
  /** @internal Bypass provider-native action dispatch so core durable delivery owns the send. */
  forceCoreDelivery?: boolean;
  /** @internal Fail before platform I/O unless the core delivery queue persisted the intent. */
  requireQueuePersistence?: boolean;
  /** @internal Stable producer id for idempotent durable queue creation. */
  deliveryIntentId?: string;
  /** @internal Serializable owner state finalized by live send or recovery. */
  deliveryCompletion?: DurableDeliveryCompletion;
  /** @internal Runs after queue persistence and before platform I/O. */
  onDeliveryIntent?: (intent: DurableMessageSendIntent) => void;
  /** @internal Revalidates caller-owned authority before each durable adapter attempt. */
  onDeliveryAttempt?: () => Promise<void>;
  /** @internal Runs on identified platform evidence before queue acknowledgement. */
  onDeliveryResult?: (result: OutboundDeliveryResult) => Promise<void> | void;
  /** @internal Revalidates caller authority immediately before recipient-visible I/O. */
  onPlatformSendDispatch?: () => Promise<void>;
  /** @internal Synchronously fence the live owner after waits and before platform I/O. */
  assertDirectAdapterHandoff?: () => void;
  /** @internal Keep ephemeral-authority sends out of replayable recovery. */
  skipQueue?: boolean;
  /** @internal Runs when broadcast converts a typed target denial into result text. */
  onActionDenied?: (
    error: MessageActionDeniedError,
    channel: ChannelId,
    receiptDiscriminator: string,
  ) => void;
  sandboxRoot?: string;
  sandboxContainerWorkdir?: string;
  dryRun?: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  sourceReplyFinal?: boolean;
  sourceReplyToolCallId?: string;
  inboundEventKind?: InboundEventKind;
  inboundAudio?: boolean;
  abortSignal?: AbortSignal;
};

export type MessageActionNormalization = {
  locationOmitted: true;
  notice: string;
};

export type MessageActionResult =
  | {
      kind: "send";
      channel: ChannelId;
      action: "send";
      to: string;
      handledBy: "plugin" | "core" | "internal-source";
      payload: unknown;
      normalization?: MessageActionNormalization;
      /** Exact text handed to the direct transport after core normalization and hooks. */
      deliveredText?: string;
      toolResult?: AgentToolResult<unknown>;
      sendResult?: MessageSendResult;
      dryRun: boolean;
    }
  | {
      kind: "broadcast";
      channel: ChannelId;
      action: "broadcast";
      handledBy: "core" | "dry-run";
      payload: {
        results: Array<{
          channel: ChannelId;
          to: string;
          ok: boolean;
          error?: string;
          sentBeforeError?: true;
          payload?: unknown;
          result?: MessageSendResult;
        }>;
      };
      dryRun: boolean;
    }
  | {
      kind: "poll";
      channel: ChannelId;
      action: "poll";
      to: string;
      handledBy: "plugin" | "core";
      payload: unknown;
      toolResult?: AgentToolResult<unknown>;
      pollResult?: MessagePollResult;
      dryRun: boolean;
    }
  | {
      kind: "action";
      channel: ChannelId;
      action: Exclude<ChannelMessageActionName, "send" | "poll">;
      handledBy: "plugin" | "dry-run";
      payload: unknown;
      toolResult?: AgentToolResult<unknown>;
      dryRun: boolean;
    };

function resolveMessageSendOutcome(
  sendResult: MessageSendResult | undefined,
  action: "Message" | "Broadcast" = "Message",
): { ok: true } | { ok: false; error: string; sentBeforeError?: true } {
  if (sendResult?.deliveryStatus === undefined || sendResult.deliveryStatus === "sent") {
    return { ok: true };
  }
  switch (sendResult.deliveryStatus) {
    case "suppressed":
      return {
        ok: false,
        error: `${action} send suppressed: ${sendResult.suppressionReason ?? "unknown reason"}.`,
      };
    case "failed":
      return { ok: false, error: sendResult.error ?? `${action} send failed.` };
    case "partial_failed":
      return {
        ok: false,
        error: sendResult.error ?? `${action} send partially failed.`,
        sentBeforeError: true,
      };
  }
  return sendResult.deliveryStatus satisfies never;
}

export function resolveMessageActionOutcome(
  result: MessageActionResult,
  action: "Message" | "Broadcast" = "Message",
): ReturnType<typeof resolveMessageSendOutcome> {
  if (result.kind === "broadcast") {
    const failure = result.payload.results.find((entry) => !entry.ok);
    return failure ? { ok: false, error: failure.error ?? "Broadcast failed." } : { ok: true };
  }
  if (result.dryRun) {
    return { ok: true };
  }
  const outcome =
    result.kind === "send"
      ? resolveMessageSendOutcome(result.sendResult, action)
      : { ok: true as const };
  const payload = result.payload;
  if (!outcome.ok || !isRecord(payload) || payload.ok !== false) {
    return outcome;
  }
  const error =
    [payload.error, payload.warning, payload.hint, payload.reason]
      .map(normalizeOptionalString)
      .find(Boolean) ?? `Message ${result.action} failed.`;
  return payload.sentBeforeError === true
    ? { ok: false, error, sentBeforeError: true }
    : { ok: false, error };
}

export function resolveMessageActionMessageId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  // SAFETY: The object check intentionally keeps array and prototype-backed payloads readable.
  const record = payload as Record<string, unknown>;
  const direct = normalizeOptionalString(record.messageId);
  if (direct) {
    return direct;
  }
  const result = record.result;
  if (!result || typeof result !== "object") {
    return undefined;
  }
  // SAFETY: The nested object check preserves the same permissive payload contract.
  return normalizeOptionalString((result as Record<string, unknown>).messageId);
}

export type ResolvedActionContext = {
  cfg: OpenClawConfig;
  params: Record<string, unknown>;
  idempotencyKey?: string;
  channel: ChannelId;
  channelPlugin: ChannelPlugin;
  mediaAccess: OutboundMediaAccess;
  extraActionMediaSourceParamKeys?: readonly string[];
  accountId?: string | null;
  dryRun: boolean;
  gateway?: MessageActionGateway;
  input: MessageActionInput;
  agentId?: string;
  resolvedTarget?: ResolvedMessagingTarget;
  abortSignal?: AbortSignal;
};
