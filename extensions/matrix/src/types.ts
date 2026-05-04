import type {
  ContextVisibilityMode,
  DmPolicy,
  GroupPolicy,
  OpenClawConfig,
  SecretInput,
} from "./runtime-api.js";

export type ReplyToMode = "off" | "first" | "all" | "batched";

type MatrixDmConfig = {
  /** If false, ignore all incoming Matrix DMs. Default: true. */
  enabled?: boolean;
  /** Direct message access policy (default: pairing). */
  policy?: DmPolicy;
  /** Allowlist for DM senders (matrix user IDs or "*"). */
  allowFrom?: Array<string | number>;
  /**
   * How Matrix DMs map to sessions.
   * - `per-user` (default): all DM rooms with the same routed peer share one DM session.
   * - `per-room`: each Matrix DM room gets its own session key.
   */
  sessionScope?: "per-user" | "per-room";
  /** Per-DM thread reply behavior override (off|inbound|always). Overrides top-level threadReplies for direct messages. */
  threadReplies?: "off" | "inbound" | "always";
};

export type MatrixRoomConfig = {
  /** Restrict this room entry to a specific Matrix account in multi-account setups. */
  account?: string;
  /** If false, disable the bot in this room. */
  enabled?: boolean;
  /** Require mentioning the bot to trigger replies. */
  requireMention?: boolean;
  /**
   * Allow messages from other configured Matrix bot accounts.
   * true accepts all configured bot senders; "mentions" requires they mention this bot.
   */
  allowBots?: boolean | "mentions";
  /** Optional tool policy overrides for this room. */
  tools?: { allow?: string[]; deny?: string[] };
  /** If true, reply without mention requirements. */
  autoReply?: boolean;
  /** Optional allowlist for room senders (matrix user IDs). */
  users?: Array<string | number>;
  /** Optional skill filter for this room. */
  skills?: string[];
  /** Optional system prompt snippet for this room. */
  systemPrompt?: string;
};

type MatrixActionConfig = {
  reactions?: boolean;
  messages?: boolean;
  pins?: boolean;
  profile?: boolean;
  memberInfo?: boolean;
  channelInfo?: boolean;
  verification?: boolean;
};

type MatrixThreadBindingsConfig = {
  enabled?: boolean;
  idleHours?: number;
  maxAgeHours?: number;
  spawnSessions?: boolean;
  defaultSpawnContext?: "isolated" | "fork";
  /** @deprecated Use spawnSessions instead. */
  spawnSubagentSessions?: boolean;
  /** @deprecated Use spawnSessions instead. */
  spawnAcpSessions?: boolean;
};

type MatrixExecApprovalTarget = "dm" | "channel" | "both";

export type MatrixExecApprovalConfig = {
  /** If true, deliver exec approvals through Matrix-native prompts. */
  enabled?: boolean;
  /** Optional approver Matrix user IDs. Falls back to dm.allowFrom. */
  approvers?: Array<string | number>;
  /** Optional agent allowlist for approval delivery. */
  agentFilter?: string[];
  /** Optional session allowlist for approval delivery. */
  sessionFilter?: string[];
  /** Where approval prompts should go. Default: dm. */
  target?: MatrixExecApprovalTarget;
};

export type MatrixStreamingMode = "partial" | "quiet" | "progress" | "off";

export type MatrixStreamingConfig = {
  /** Preview streaming mode for Matrix replies. Default: "off". */
  mode?: MatrixStreamingMode;
  progress?: import("openclaw/plugin-sdk/channel-streaming").ChannelStreamingProgressConfig;
  preview?: {
    /** Show tool/progress activity in the live draft preview. Default: true. */
    toolProgress?: boolean;
  };
};

type MatrixNetworkConfig = {
  /** Dangerous opt-in for trusted private/internal Matrix homeservers. */
  dangerouslyAllowPrivateNetwork?: boolean;
};

/** Per-account Matrix config (excludes the accounts field to prevent recursion). */
export type MatrixAccountConfig = Omit<MatrixConfig, "accounts">;

export type MatrixConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** If false, do not start Matrix. Default: true. */
  enabled?: boolean;
  /** Multi-account configuration keyed by account ID. */
  accounts?: Record<string, MatrixAccountConfig>;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
  /** Matrix homeserver URL (https://matrix.example.org). */
  homeserver?: string;
  /** Network policy overrides for trusted private/internal Matrix homeservers. */
  network?: MatrixNetworkConfig;
  /** Optional HTTP(S) proxy URL for Matrix connections (e.g. http://127.0.0.1:7890). */
  proxy?: string;
  /** Matrix user id (@user:server). */
  userId?: string;
  /** Matrix access token. */
  accessToken?: SecretInput;
  /** Matrix password (used only to fetch access token). */
  password?: SecretInput;
  /** Optional Matrix device id (recommended when using access tokens + E2EE). */
  deviceId?: string;
  /** Optional device name when logging in via password. */
  deviceName?: string;
  /** Optional desired Matrix avatar source (mxc:// or http(s) URL). */
  avatarUrl?: string;
  /** Initial sync limit for startup (defaults to matrix-js-sdk behavior). */
  initialSyncLimit?: number;
  /** Enable end-to-end encryption (E2EE). Default: false. */
  encryption?: boolean;
  /** If true, enforce allowlists for groups + DMs regardless of policy. */
  allowlistOnly?: boolean;
  /**
   * Allow messages from other configured Matrix bot accounts.
   * true accepts all configured bot senders; "mentions" requires they mention this bot.
   */
  allowBots?: boolean | "mentions";
  /** Group message policy (default: allowlist). */
  groupPolicy?: GroupPolicy;
  /** Supplemental context visibility policy (all|allowlist|allowlist_quote). */
  contextVisibility?: ContextVisibilityMode;
  /**
   * Enable shared block-streaming replies for Matrix.
   *
   * Default: false. Matrix keeps `streaming: "off"` as final-only delivery
   * unless block streaming is explicitly enabled.
   */
  blockStreaming?: boolean;
  /** Allowlist for group senders (matrix user IDs). */
  groupAllowFrom?: Array<string | number>;
  /** Control reply threading when reply tags are present (off|first|all|batched). */
  replyToMode?: ReplyToMode;
  /** How to handle thread replies (off|inbound|always). */
  threadReplies?: "off" | "inbound" | "always";
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string;
  /** Ack reaction emoji override for this channel/account. */
  ackReaction?: string;
  /** Ack reaction scope override for this channel/account. */
  ackReactionScope?: "group-mentions" | "group-all" | "direct" | "all" | "none" | "off";
  /** Inbound reaction notifications for bot-authored Matrix messages. */
  reactionNotifications?: "off" | "own";
  /** Thread/session binding behavior for Matrix room threads. */
  threadBindings?: MatrixThreadBindingsConfig;
  /** Whether Matrix should auto-request self verification on startup when unverified. */
  startupVerification?: "off" | "if-unverified";
  /** Cooldown window for automatic startup verification requests. Default: 24 hours. */
  startupVerificationCooldownHours?: number;
  /** Max outbound media size in MB. */
  mediaMaxMb?: number;
  /**
   * Number of recent room messages shown to the agent as context when it is mentioned
   * in a group chat (0 = disabled). Applies to room messages that did not directly
   * trigger a reply. Default: 0 (disabled).
   */
  historyLimit?: number;
  /** Auto-join invites (always|allowlist|off). Default: off. */
  autoJoin?: "always" | "allowlist" | "off";
  /** Allowlist for auto-join invites (room IDs, aliases). */
  autoJoinAllowlist?: Array<string | number>;
  /** Direct message policy + allowlist overrides. */
  dm?: MatrixDmConfig;
  /** Matrix-native exec approval delivery config. */
  execApprovals?: MatrixExecApprovalConfig;
  /** Room config allowlist keyed by room ID or alias (names resolved to IDs when possible). */
  groups?: Record<string, MatrixRoomConfig>;
  /** @deprecated Use groups. */
  rooms?: Record<string, MatrixRoomConfig>;
  /** Per-action tool gating (default: true for all). */
  actions?: MatrixActionConfig;
  /**
   * Streaming mode for Matrix replies.
   * - `"partial"`: edit a single draft message in place for the current
   *   assistant block as the model generates text using normal Matrix text
   *   messages. This preserves legacy preview-first notification behavior.
   * - `"quiet"`: edit a single quiet draft notice in place for the current
   *   assistant block as the model generates text.
   * - `"progress"`: edit a single draft status message with shared progress
   *   labels and optional tool/task lines until the final answer is ready.
   * - `"off"`: deliver the full reply once the model finishes.
   * - Use `blockStreaming: true` when you want completed assistant blocks to
   *   stay visible as separate progress messages. When combined with
   *   preview streaming, Matrix keeps a live draft for the current block and
   *   preserves completed blocks as separate messages.
   * - `streaming.progress.toolProgress: false` hides interim tool/progress
   *   lines in progress mode. `streaming.preview.toolProgress: false` keeps
   *   legacy answer preview edits but hides interim tool/progress lines.
   * - `true` maps to `"partial"`, `false` maps to `"off"` for backward
   *   compatibility. Object form uses `streaming.mode`.
   * Default: `"off"`.
   */
  streaming?: MatrixStreamingMode | MatrixStreamingConfig | boolean;
};

export type CoreConfig = {
  channels?: {
    matrix?: MatrixConfig;
    defaults?: {
      groupPolicy?: "open" | "allowlist" | "disabled";
      contextVisibility?: ContextVisibilityMode;
    };
  };
  commands?: {
    useAccessGroups?: boolean;
  };
  session?: {
    store?: string;
    dmScope?: NonNullable<OpenClawConfig["session"]>["dmScope"];
  };
  messages?: {
    ackReaction?: string;
    ackReactionScope?: "group-mentions" | "group-all" | "direct" | "all" | "none" | "off";
  };
  secrets?: OpenClawConfig["secrets"];
  [key: string]: unknown;
};
