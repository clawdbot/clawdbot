/**
 * Gateway types.
 *
 * core/gateway/gateway.ts now imports all dependencies directly (both
 * core/ modules and upper-layer files). The only injected dependency
 * is `runtime` (PluginRuntime), which is a framework-provided object.
 */

// ============ Logger ============
import type { EngineLogger } from "../types.js";
export type { EngineLogger };

// ============ Account ============

/** Re-export GatewayAccount from engine/types.ts (single source of truth). */
import type { GatewayAccount as _GatewayAccount } from "../types.js";
export type GatewayAccount = _GatewayAccount;

// ============ PluginRuntime subset ============

/**
 * Subset of PluginRuntime used by the gateway.
 *
 * This is NOT a custom adapter — it's the exact same object shape that
 * the framework injects. We define it here so core/ doesn't need to
 * depend on the plugin-sdk root barrel.
 */
export interface GatewayPluginRuntime {
  channel: {
    activity: {
      record: (params: {
        channel: string;
        accountId: string;
        direction: "inbound" | "outbound";
      }) => void;
    };
    routing: {
      resolveAgentRoute: (params: {
        cfg: unknown;
        channel: string;
        accountId: string;
        peer: { kind: "group" | "direct"; id: string };
      }) => { sessionKey: string; accountId: string; agentId?: string };
    };
    reply: {
      dispatchReplyWithBufferedBlockDispatcher: (params: unknown) => Promise<unknown>;
      resolveEffectiveMessagesConfig: (
        cfg: unknown,
        agentId?: string,
      ) => { responsePrefix?: string };
      finalizeInboundContext: (fields: Record<string, unknown>) => unknown;
      formatInboundEnvelope: (params: unknown) => string;
      resolveEnvelopeFormatOptions: (cfg: unknown) => unknown;
    };
    text: {
      chunkMarkdownText: (text: string, limit: number) => string[];
    };
  };
  tts: {
    textToSpeech: (params: { text: string; cfg: unknown; channel: string }) => Promise<{
      success: boolean;
      audioPath?: string;
      provider?: string;
      outputFormat?: string;
      error?: string;
    }>;
  };
}

// ============ Shared result types ============

/** Re-export ProcessedAttachments from inbound-attachments (single source of truth). */
export type { ProcessedAttachments } from "./inbound-attachments.js";

/** Outbound result from media sends. */
export interface OutboundResult {
  channel: string;
  messageId?: string;
  timestamp?: string | number;
  error?: string;
}

/** Re-export RefAttachmentSummary for convenience. */
export type { RefAttachmentSummary } from "../ref/types.js";

// ============ WebSocket Event Types ============

/** Raw WebSocket payload structure. */
export interface WSPayload {
  op: number;
  d: unknown;
  s?: number;
  t?: string;
}

/** Attachment shape shared by all message event types. */
export interface RawMessageAttachment {
  content_type: string;
  url: string;
  filename?: string;
  voice_wav_url?: string;
  asr_refer_text?: string;
}

/** Referenced message element (used for quote messages). */
export interface RawMsgElement {
  msg_idx?: string;
  content?: string;
  attachments?: Array<
    RawMessageAttachment & {
      height?: number;
      width?: number;
      size?: number;
    }
  >;
}

export interface C2CMessageEvent {
  id: string;
  content: string;
  timestamp: string;
  author: { user_openid: string };
  attachments?: RawMessageAttachment[];
  message_scene?: { ext?: string[] };
  message_type?: number;
  msg_elements?: RawMsgElement[];
}

export interface GuildMessageEvent {
  id: string;
  content: string;
  timestamp: string;
  author: { id: string; username?: string };
  channel_id: string;
  guild_id: string;
  attachments?: RawMessageAttachment[];
  message_scene?: { ext?: string[] };
}

export interface GroupMessageEvent {
  id: string;
  content: string;
  timestamp: string;
  author: { member_openid: string };
  group_openid: string;
  attachments?: RawMessageAttachment[];
  message_scene?: { ext?: string[] };
  message_type?: number;
  msg_elements?: RawMsgElement[];
}

// ============ Gateway Context ============

/** Full gateway startup context. Only `runtime` is injected; everything else is imported directly. */
export interface CoreGatewayContext {
  account: GatewayAccount;
  abortSignal: AbortSignal;
  cfg: unknown;
  onReady?: (data: unknown) => void;
  /**
   * Invoked when a RESUMED event is received after reconnect.
   * Falls back to `onReady` when not provided so existing callers
   * keep their current behaviour.
   */
  onResumed?: (data: unknown) => void;
  onError?: (error: Error) => void;
  log?: EngineLogger;
  /** PluginRuntime injected by the framework — same object in both versions. */
  runtime: GatewayPluginRuntime;
}
