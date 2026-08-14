import type { AgentToolResult } from "../../agents/runtime/index.js";
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
  toolContext?: ChannelThreadingToolContext;
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
  /** @internal Runs on identified platform evidence before queue acknowledgement. */
  onDeliveryResult?: (result: OutboundDeliveryResult) => Promise<void> | void;
  sandboxRoot?: string;
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
