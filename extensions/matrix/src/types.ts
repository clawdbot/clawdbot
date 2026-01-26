export type ReplyToMode = "off" | "first" | "all";
export type GroupPolicy = "open" | "disabled" | "allowlist";
export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";

export type MatrixDmConfig = {
  /** If false, ignore all incoming Matrix DMs. Default: true. */
  enabled?: boolean;
  /** Direct message access policy (default: pairing). */
  policy?: DmPolicy;
  /** Allowlist for DM senders (matrix user IDs, localparts, or "*"). */
  allowFrom?: Array<string | number>;
};

export type MatrixRoomConfig = {
  /** If false, disable the bot in this room (alias for allow: false). */
  enabled?: boolean;
  /** Legacy room allow toggle; prefer enabled. */
  allow?: boolean;
  /** Require mentioning the bot to trigger replies. */
  requireMention?: boolean;
  /** Optional tool policy overrides for this room. */
  tools?: { allow?: string[]; deny?: string[] };
  /** If true, reply without mention requirements. */
  autoReply?: boolean;
  /** Optional allowlist for room senders (user IDs or localparts). */
  users?: Array<string | number>;
  /** Optional skill filter for this room. */
  skills?: string[];
  /** Optional system prompt snippet for this room. */
  systemPrompt?: string;
};

export type MatrixActionConfig = {
  reactions?: boolean;
  messages?: boolean;
  pins?: boolean;
  memberInfo?: boolean;
  channelInfo?: boolean;
};

export type MatrixConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** If false, do not start Matrix. Default: true. */
  enabled?: boolean;
  /** Matrix homeserver URL (https://matrix.example.org). */
  homeserver?: string;
  /** Matrix user id (@user:server). */
  userId?: string;
  /** Matrix access token. */
  accessToken?: string;
  /** Matrix password (used only to fetch access token). */
  password?: string;
  /** Optional device name when logging in via password. */
  deviceName?: string;
  /** Initial sync limit for startup (default: matrix-bot-sdk default). */
  initialSyncLimit?: number;
  /** Enable end-to-end encryption (E2EE). Default: false. */
  encryption?: boolean;
  /** If true, enforce allowlists for groups + DMs regardless of policy. */
  allowlistOnly?: boolean;
  /** Group message policy (default: allowlist). */
  groupPolicy?: GroupPolicy;
  /** Allowlist for group senders (user IDs or localparts). */
  groupAllowFrom?: Array<string | number>;
  /** Control reply threading when reply tags are present (off|first|all). */
  replyToMode?: ReplyToMode;
  /** How to handle thread replies (off|inbound|always). */
  threadReplies?: "off" | "inbound" | "always";
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  /** Max outbound media size in MB. */
  mediaMaxMb?: number;
  /** Auto-join invites (always|allowlist|off). Default: always. */
  autoJoin?: "always" | "allowlist" | "off";
  /** Allowlist for auto-join invites (room IDs, aliases). */
  autoJoinAllowlist?: Array<string | number>;
  /** Direct message policy + allowlist overrides. */
  dm?: MatrixDmConfig;
  /** Room config allowlist keyed by room ID, alias, or name. */
  groups?: Record<string, MatrixRoomConfig>;
  /** Room config allowlist keyed by room ID, alias, or name. Legacy; use groups. */
  rooms?: Record<string, MatrixRoomConfig>;
  /** Per-action tool gating (default: true for all). */
  actions?: MatrixActionConfig;
};

export type CoreConfig = {
  channels?: {
    matrix?: MatrixConfig;
  };
  [key: string]: unknown;
};
