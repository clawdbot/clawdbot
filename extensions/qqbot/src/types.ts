import type { SecretInput } from "openclaw/plugin-sdk/secret-input";
import type { QQBotDmPolicy, QQBotGroupPolicy } from "./engine/access/index.js";

export type { QQBotDmPolicy, QQBotGroupPolicy };

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

/** QQBot-native exec approval delivery + approver authorization. */
export interface QQBotExecApprovalConfig {
  enabled?: boolean | "auto";
  approvers?: string[];
  agentFilter?: string[];
  sessionFilter?: string[];
  target?: "dm" | "channel" | "both";
}

/** QQ Bot account config from user settings. */
export interface QQBotAccountConfig {
  enabled?: boolean;
  name?: string;
  appId?: string;
  clientSecret?: SecretInput;
  clientSecretFile?: string;
  /**
   * Sender allowlist for direct-message access control and command
   * authorization. Entries accept raw openids, `qqbot:OPENID` prefixed
   * form, and the `"*"` wildcard. Matching is case-insensitive.
   *
   * Semantics depend on {@link dmPolicy}:
   *   - `dmPolicy="open"` (default when allowFrom is empty or contains `"*"`)
   *     — everyone can DM the bot; the list only influences command gating.
   *   - `dmPolicy="allowlist"` (default when a non-wildcard list is configured)
   *     — only listed openids may DM the bot; other DMs are dropped.
   *   - `dmPolicy="disabled"` — all DMs are dropped regardless of this list.
   *
   * For group access, see {@link groupAllowFrom} / {@link groupPolicy}.
   */
  allowFrom?: string[];
  /**
   * Group-scoped sender allowlist. If omitted, group access falls back to
   * {@link allowFrom}. Set explicitly when the group whitelist needs to
   * differ from the DM whitelist.
   */
  groupAllowFrom?: string[];
  /**
   * DM access policy. Defaults:
   *   - omitted + allowFrom empty/wildcard → `"open"`
   *   - omitted + allowFrom non-wildcard   → `"allowlist"`
   */
  dmPolicy?: QQBotDmPolicy;
  /**
   * Group access policy. Defaults mirror {@link dmPolicy}: if either
   * `groupAllowFrom` or `allowFrom` has a non-wildcard entry the policy
   * is `"allowlist"`, otherwise `"open"`.
   */
  groupPolicy?: QQBotGroupPolicy;
  /** Optional system prompt prepended to user messages. */
  systemPrompt?: string;
  /** Whether markdown output is enabled. Defaults to true. */
  markdownSupport?: boolean;
  /** QQBot-native exec approval delivery + approver authorization. */
  execApprovals?: QQBotExecApprovalConfig;
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
   * Block streaming + optional QQ C2C official stream API.
   * - `true`: same as `mode: "partial"` and `c2cStreamApi: true` (recommended).
   * - `false` / omitted: no official C2C stream for this account (see object form for fine control).
   * - Object (legacy / advanced): `mode` "partial" | "off", `c2cStreamApi` for C2C `/stream_messages`.
   */
  streaming?:
    | boolean
    | {
        mode?: "off" | "partial";
        /** @deprecated Prefer `streaming: true`. */
        c2cStreamApi?: boolean;
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
