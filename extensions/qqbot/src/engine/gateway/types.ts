import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { EngineLogger } from "../types.js";
export type { EngineLogger };

import type { GatewayAccount as _GatewayAccount } from "../types.js";
export type GatewayAccount = _GatewayAccount;

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
    commands?: {
      isControlCommandMessage?: (text?: string, cfg?: unknown) => boolean;
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
    session: {
      resolveStorePath: (store: unknown, params: { agentId: string }) => string;
      recordInboundSession: (params: unknown) => Promise<unknown>;
    };
    turn: {
      run: (params: unknown) => Promise<unknown>;
    };
    text: {
      chunkMarkdownText: (text: string, limit: number) => string[];
    };
  };
  tts: {
    textToSpeech: (params: {
      text: string;
      cfg: unknown;
      channel: string;
      accountId?: string;
    }) => Promise<{
      success: boolean;
      audioPath?: string;
      provider?: string;
      outputFormat?: string;
      error?: string;
    }>;
  };
  config?: {
    current: () => Record<string, unknown>;
    replaceConfigFile: (params: {
      nextConfig: unknown;
      afterWrite: { mode: "auto" };
    }) => Promise<unknown>;
  };
}

export type { ProcessedAttachments } from "./inbound-attachments.js";

export interface OutboundResult {
  channel: string;
  messageId?: string;
  timestamp?: string | number;
  error?: string;
}

export type { RefAttachmentSummary } from "../ref/types.js";

export interface WSPayload {
  op: number;
  d: unknown;
  s?: number;
  t?: string;
}

interface RawMessageAttachment {
  content_type: string;
  url: string;
  filename?: string;
  voice_wav_url?: string;
  asr_refer_text?: string;
}

interface RawMsgElement {
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
  author: {
    member_openid: string;
    username?: string;
    /** True when the sender is itself a bot. */
    bot?: boolean;
  };
  group_openid: string;
  attachments?: RawMessageAttachment[];
  /** Optional @mentions list with per-entry is_you / member_openid / nickname. */
  mentions?: Array<{
    scope?: "all" | "single";
    id?: string;
    user_openid?: string;
    member_openid?: string;
    nickname?: string;
    username?: string;
    bot?: boolean;
    /** `true` when this mention targets the bot itself. */
    is_you?: boolean;
  }>;
  message_scene?: { source?: string; ext?: string[] };
  message_type?: number;
  msg_elements?: RawMsgElement[];
}

// ============ Gateway Context ============

import type { EngineAdapters } from "../adapter/index.js";

/**
 * Group-chat behaviour options.
 *
 * Grouped under a dedicated sub-object on {@link CoreGatewayContext} so
 * future additions (admin lookup, proactive push, per-group toggles)
 * don't keep polluting the top-level context type.
 */
interface GatewayGroupOptions {
  /**
   * Whether group-chat gating is enabled. Defaults to `true`; set to
   * `false` to disable all group processing (e.g. for a DM-only smoke
   * test). When disabled, the engine does not allocate a history
   * buffer and does not instantiate the session-store reader.
   */
  enabled?: boolean;
  /**
   * Whether the framework has text-based control commands enabled. When
   * `false`, the group gate skips the "unauthorized command" check and
   * the command-bypass path.
   */
  allowTextCommands?: boolean;
  /**
   * Optional probe that returns true when `content` is a recognised
   * control command. Injected to avoid hard-coding a command list in
   * the engine. When omitted, no message is treated as a control
   * command and the bypass path never activates.
   */
  isControlCommand?: (content: string) => boolean;
  /**
   * Platform hook that contributes a channel-level group intro hint
   * (e.g. "当前群: 开发讨论组"). Invoked per-group when building the
   * system prompt.
   */
  resolveIntroHint?: (params: {
    cfg: unknown;
    accountId: string;
    groupId: string;
  }) => string | undefined;
  /**
   * Session-store reader for the `/activation` command override. When
   * omitted, the engine loads a default node-based reader lazily.
   */
  sessionStoreReader?: import("../group/activation.js").SessionStoreReader;
}

/** Full gateway startup context. */
export interface CoreGatewayContext {
  account: GatewayAccount;
  abortSignal: AbortSignal;
  cfg: OpenClawConfig;
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
  /** Group-chat tuning options. */
  group?: GatewayGroupOptions;
  /** Adapter ports — delegates audio, history, mention gating, commands to bridge implementations. */
  adapters: EngineAdapters;
}
