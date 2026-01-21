import type { BlockStreamingCoalesceConfig } from "./types.base.js";

export type MattermostChatMode = "oncall" | "onmessage" | "onchar";

export type MattermostAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** If false, do not start this Mattermost account. Default: true. */
  enabled?: boolean;
  /** Bot token for Mattermost. */
  botToken?: string;
  /** Base URL for the Mattermost server (e.g., https://chat.example.com). */
  baseUrl?: string;
  /**
   * Controls when channel messages trigger replies.
   * - "oncall": only respond when mentioned
   * - "onmessage": respond to every channel message
   * - "onchar": respond when a trigger character prefixes the message
   */
  chatmode?: MattermostChatMode;
  /** Prefix characters that trigger onchar mode (default: [">", "!"]). */
  oncharPrefixes?: string[];
  /** Require @mention to respond in channels. Default: true. */
  requireMention?: boolean;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
};

export type MattermostConfig = {
  /** Optional per-account Mattermost configuration (multi-account). */
  accounts?: Record<string, MattermostAccountConfig>;
} & MattermostAccountConfig;
