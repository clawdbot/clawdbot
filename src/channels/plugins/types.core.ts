import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { MoltbotConfig } from "../../config/config.js";
import type { PollInput } from "../../polls.js";
import type { GatewayClientMode, GatewayClientName } from "../../utils/message-channel.js";
import type { NormalizedChatType } from "../chat-type.js";
import type { ChatChannelId } from "../registry.js";
import type { ChannelMessageActionName as ChannelMessageActionNameFromList } from "./message-action-names.js";

export type ChannelId = ChatChannelId | (string & {});

export type ChannelOutboundTargetMode = "explicit" | "implicit" | "heartbeat";

export type ChannelAgentTool = AgentTool<TSchema, unknown>;

export type ChannelAgentToolFactory = (params: { cfg?: MoltbotConfig }) => ChannelAgentTool[];

export type ChannelSetupInput = {
  name?: string;
  token?: string;
  tokenFile?: string;
  botToken?: string;
  appToken?: string;
  signalNumber?: string;
  cliPath?: string;
  dbPath?: string;
  service?: "imessage" | "sms" | "auto";
  region?: string;
  authDir?: string;
  httpUrl?: string;
  httpHost?: string;
  httpPort?: string;
  webhookPath?: string;
  webhookUrl?: string;
  audienceType?: string;
  audience?: string;
  useEnv?: boolean;
  homeserver?: string;
  userId?: string;
  accessToken?: string;
  password?: string;
  deviceName?: string;
  initialSyncLimit?: number;
  ship?: string;
  url?: string;
  code?: string;
  groupChannels?: string[];
  dmAllowlist?: string[];
  autoDiscoverChannels?: boolean;
};

export type ChannelStatusIssue = {
  channel: ChannelId;
  accountId: string;
  kind: "intent" | "permissions" | "config" | "auth" | "runtime";
  message: string;
  fix?: string;
};

export type ChannelAccountState =
  | "linked"
  | "not linked"
  | "configured"
  | "not configured"
  | "enabled"
  | "disabled";

export type ChannelHeartbeatDeps = {
  webAuthExists?: () => Promise<boolean>;
  hasActiveWebListener?: () => boolean;
};

export type ChannelMeta = {
  id: ChannelId;
  label: string;
  selectionLabel: string;
  docsPath: string;
  docsLabel?: string;
  blurb: string;
  order?: number;
  aliases?: string[];
  selectionDocsPrefix?: string;
  selectionDocsOmitLabel?: boolean;
  selectionExtras?: string[];
  detailLabel?: string;
  systemImage?: string;
  showConfigured?: boolean;
  quickstartAllowFrom?: boolean;
  forceAccountBinding?: boolean;
  preferSessionLookupForAnnounceTarget?: boolean;
  preferOver?: string[];
};

export type ChannelAccountSnapshot = {
  accountId: string;
  name?: string;
  enabled?: boolean;
  configured?: boolean;
  linked?: boolean;
  running?: boolean;
  connected?: boolean;
  reconnectAttempts?: number;
  lastConnectedAt?: number | null;
  lastDisconnect?:
    | string
    | {
        at: number;
        status?: number;
        error?: string;
        loggedOut?: boolean;
      }
    | null;
  lastMessageAt?: number | null;
  lastEventAt?: number | null;
  lastError?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  mode?: string;
  dmPolicy?: string;
  allowFrom?: string[];
  tokenSource?: string;
  botTokenSource?: string;
  appTokenSource?: string;
  credentialSource?: string;
  audienceType?: string;
  audience?: string;
  webhookPath?: string;
  webhookUrl?: string;
  baseUrl?: string;
  allowUnmentionedGroups?: boolean;
  cliPath?: string | null;
  dbPath?: string | null;
  port?: number | null;
  probe?: unknown;
  lastProbeAt?: number | null;
  audit?: unknown;
  application?: unknown;
  bot?: unknown;
};

export type ChannelLogSink = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};

export type ChannelGroupContext = {
  cfg: MoltbotConfig;
  groupId?: string | null;
  /** Human label for channel-like group conversations (e.g. #general). */
  groupChannel?: string | null;
  groupSpace?: string | null;
  accountId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
};

export type ChannelCapabilities = {
  chatTypes: Array<NormalizedChatType | "thread">;
  polls?: boolean;
  reactions?: boolean;
  edit?: boolean;
  unsend?: boolean;
  reply?: boolean;
  effects?: boolean;
  groupManagement?: boolean;
  threads?: boolean;
  media?: boolean;
  nativeCommands?: boolean;
  blockStreaming?: boolean;
};

export type ChannelSecurityDmPolicy = {
  policy: string;
  allowFrom?: Array<string | number> | null;
  policyPath?: string;
  allowFromPath: string;
  approveHint: string;
  normalizeEntry?: (raw: string) => string;
};

export type ChannelSecurityContext<ResolvedAccount = unknown> = {
  cfg: MoltbotConfig;
  accountId?: string | null;
  account: ResolvedAccount;
};

export type ChannelMentionAdapter = {
  stripPatterns?: (params: {
    ctx: MsgContext;
    cfg: MoltbotConfig | undefined;
    agentId?: string;
  }) => string[];
  stripMentions?: (params: {
    text: string;
    ctx: MsgContext;
    cfg: MoltbotConfig | undefined;
    agentId?: string;
  }) => string;
};

export type ChannelStreamingAdapter = {
  blockStreamingCoalesceDefaults?: {
    minChars: number;
    idleMs: number;
  };
};

export type ChannelThreadingAdapter = {
  resolveReplyToMode?: (params: {
    cfg: MoltbotConfig;
    accountId?: string | null;
    chatType?: string | null;
  }) => "off" | "first" | "all";
  allowTagsWhenOff?: boolean;
  buildToolContext?: (params: {
    cfg: MoltbotConfig;
    accountId?: string | null;
    context: ChannelThreadingContext;
    hasRepliedRef?: { value: boolean };
  }) => ChannelThreadingToolContext | undefined;
};

export type ChannelThreadingContext = {
  Channel?: string;
  From?: string;
  To?: string;
  ChatType?: string;
  ReplyToId?: string;
  ReplyToIdFull?: string;
  ThreadLabel?: string;
  MessageThreadId?: string | number;
};

export type ChannelThreadingToolContext = {
  currentChannelId?: string;
  currentChannelProvider?: ChannelId;
  currentThreadTs?: string;
  replyToMode?: "off" | "first" | "all";
  hasRepliedRef?: { value: boolean };
  /**
   * When true, skip cross-context decoration (e.g., "[from X]" prefix).
   * Use this for direct tool invocations where the agent is composing a new message,
   * not forwarding/relaying a message from another conversation.
   */
  skipCrossContextDecoration?: boolean;
};

export type ChannelMessagingAdapter = {
  normalizeTarget?: (raw: string) => string | undefined;
  targetResolver?: {
    looksLikeId?: (raw: string, normalized?: string) => boolean;
    hint?: string;
  };
  formatTargetDisplay?: (params: {
    target: string;
    display?: string;
    kind?: ChannelDirectoryEntryKind;
  }) => string;
};

export type ChannelAgentPromptAdapter = {
  messageToolHints?: (params: { cfg: MoltbotConfig; accountId?: string | null }) => string[];
};

export type ChannelDirectoryEntryKind = "user" | "group" | "channel";

export type ChannelDirectoryEntry = {
  kind: ChannelDirectoryEntryKind;
  id: string;
  name?: string;
  handle?: string;
  avatarUrl?: string;
  rank?: number;
  raw?: unknown;
};

export type ChannelMessageActionName = ChannelMessageActionNameFromList;

export type ChannelMessageActionContext = {
  channel: ChannelId;
  action: ChannelMessageActionName;
  cfg: MoltbotConfig;
  params: Record<string, unknown>;
  accountId?: string | null;
  gateway?: {
    url?: string;
    token?: string;
    timeoutMs?: number;
    clientName: GatewayClientName;
    clientDisplayName?: string;
    mode: GatewayClientMode;
  };
  toolContext?: ChannelThreadingToolContext;
  dryRun?: boolean;
};

export type ChannelToolSend = {
  to: string;
  accountId?: string | null;
};

export type ChannelMessageActionAdapter = {
  listActions?: (params: { cfg: MoltbotConfig }) => ChannelMessageActionName[];
  supportsAction?: (params: { action: ChannelMessageActionName }) => boolean;
  supportsButtons?: (params: { cfg: MoltbotConfig }) => boolean;
  supportsCards?: (params: { cfg: MoltbotConfig }) => boolean;
  extractToolSend?: (params: { args: Record<string, unknown> }) => ChannelToolSend | null;
  handleAction?: (ctx: ChannelMessageActionContext) => Promise<AgentToolResult<unknown>>;
};

export type ChannelPollResult = {
  messageId: string;
  toJid?: string;
  channelId?: string;
  conversationId?: string;
  pollId?: string;
};

export type ChannelPollContext = {
  cfg: MoltbotConfig;
  to: string;
  poll: PollInput;
  accountId?: string | null;
};
