import type { SecretInput } from "openclaw/plugin-sdk/secret-input";

/** QQ Bot base config. */
export interface QQBotConfig {
  appId: string;
  clientSecret?: SecretInput;
  clientSecretFile?: string;
}

/** Resolved QQ Bot account config used at runtime. */
export interface ResolvedQQBotAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  appId: string;
  clientSecret: string;
  secretSource: "config" | "file" | "env" | "none";
  /** Additional system prompt text. */
  systemPrompt?: string;
  /** Whether markdown output is enabled. Defaults to true. */
  markdownSupport: boolean;
  config: QQBotAccountConfig;
}

/** QQ Bot account config from user settings. */
export interface QQBotAccountConfig {
  enabled?: boolean;
  name?: string;
  appId?: string;
  clientSecret?: SecretInput;
  clientSecretFile?: string;
  allowFrom?: string[];
  /** Optional system prompt prepended to user messages. */
  systemPrompt?: string;
  /** Whether markdown output is enabled. Defaults to true. */
  markdownSupport?: boolean;
  /**
   * @deprecated Use audioFormatPolicy.uploadDirectFormats instead.
   * Legacy list of formats that can upload directly without SILK conversion.
   */
  voiceDirectUploadFormats?: string[];
  /**
   * Audio format policy covering inbound STT and outbound upload behavior.
   */
  audioFormatPolicy?: AudioFormatPolicy;
  /**
   * Whether public URLs should be uploaded to QQ directly. Defaults to true.
   */
  urlDirectUpload?: boolean;
  /**
   * Upgrade guide URL returned by `/bot-upgrade`.
   */
  upgradeUrl?: string;
  /**
   * Upgrade command mode.
   * - "doc": show an upgrade guide link
   * - "hot-reload": run an in-place npm update flow
   */
  upgradeMode?: "doc" | "hot-reload";
  /**
   * Block streaming configuration.
   * - mode "partial" (default): enable block streaming for incremental delivery.
   * - mode "off": buffer the full response before sending.
   */
  streaming?: {
    mode?: "off" | "partial";
  };
}

/** Audio format policy controlling which formats can skip transcoding. */
export interface AudioFormatPolicy {
  /**
   * Formats supported directly by the STT provider.
   */
  sttDirectFormats?: string[];
  /**
   * Formats QQ accepts directly for outbound uploads.
   */
  uploadDirectFormats?: string[];
  /**
   * Whether outbound audio transcoding is enabled. Defaults to true.
   */
  transcodeEnabled?: boolean;
}

/** Rich-media attachment metadata. */
export interface MessageAttachment {
  content_type: string;
  filename?: string;
  height?: number;
  width?: number;
  size?: number;
  url: string;
  voice_wav_url?: string;
  asr_refer_text?: string;
}

/** C2C message event payload. */
export interface C2CMessageEvent {
  author: {
    id: string;
    union_openid: string;
    user_openid: string;
  };
  content: string;
  id: string;
  timestamp: string;
  message_scene?: {
    source: string;
    /** ext can contain ref_msg_idx and msg_idx values. */
    ext?: string[];
  };
  attachments?: MessageAttachment[];
}

/** Guild @-message event payload. */
export interface GuildMessageEvent {
  id: string;
  channel_id: string;
  guild_id: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    username?: string;
    bot?: boolean;
  };
  member?: {
    nick?: string;
    joined_at?: string;
  };
  attachments?: MessageAttachment[];
}

/** Group @-message event payload. */
export interface GroupMessageEvent {
  author: {
    id: string;
    member_openid: string;
  };
  content: string;
  id: string;
  timestamp: string;
  group_id: string;
  group_openid: string;
  message_scene?: {
    source: string;
    ext?: string[];
  };
  attachments?: MessageAttachment[];
}

/** WebSocket event payload. */
export interface WSPayload {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}
