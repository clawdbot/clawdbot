import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { MarkdownTableMode } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayClientMode, GatewayClientName } from "../../gateway/protocol/client-info.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import type { PollInput } from "../../polls.js";
import type { ChatType } from "../chat-type.js";
import type { ChannelId } from "./channel-id.types.js";
import type { ChannelMessageActionName as ChannelMessageActionNameFromList } from "./message-action-names.js";
import type { ChannelMessageCapability } from "./message-capabilities.js";

export type { ChannelId } from "./channel-id.types.js";

export type ChannelExposure = {
  configured?: boolean;
  setup?: boolean;
  docs?: boolean;
};

export type ChannelOutboundTargetMode = "explicit" | "implicit" | "heartbeat";

/** Agent tool registered by a channel plugin. */
export type ChannelAgentTool = AgentTool<TSchema, unknown> & {
  ownerOnly?: boolean;
};

/** Lazy agent-tool factory used when tool availability depends on config. */
export type ChannelAgentToolFactory = (params: { cfg?: OpenClawConfig }) => ChannelAgentTool[];

/**
 * Discovery-time inputs passed to channel action adapters when the core is
 * asking what an agent should be allowed to see. This is intentionally
 * smaller than execution context: it carries routing/account scope, but no
 * tool params or runtime handles.
 */
export type ChannelMessageActionDiscoveryContext = {
  cfg: OpenClawConfig;
  currentChannelId?: string | null;
  currentChannelProvider?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  requesterSenderId?: string | null;
  senderIsOwner?: boolean;
};

/**
 * Plugin-owned schema fragments for the shared `message` tool.
 * `current-channel` means expose the fields only when that provider is the
 * active runtime channel. `all-configured` keeps the fields visible even while
 * another configured channel is active, which is useful for cross-channel
 * sends from cron or isolated agents.
 */
export type ChannelMessageToolSchemaContribution = {
  properties: Record<string, TSchema>;
  visibility?: "current-channel" | "all-configured";
};

type ChannelMessageToolMediaSourceParams =
  | readonly string[]
  | Partial<Record<ChannelMessageActionName, readonly string[]>>;

export type ChannelMessageToolDiscovery = {
  actions?: readonly ChannelMessageActionName[] | null;
  capabilities?: readonly ChannelMessageCapability[] | null;
  schema?: ChannelMessageToolSchemaContribution | ChannelMessageToolSchemaContribution[] | null;
  /**
   * Plugin-owned message-tool params that carry media sources.
   * Core uses this to derive sandbox path normalization and host media-access
   * hints without hardcoding plugin-specific param names. Prefer scoping keys
   * by action so unrelated actions do not inherit another action's media args.
   */
  mediaSourceParams?: ChannelMessageToolMediaSourceParams | null;
};

/** Shared setup input bag used by CLI, onboarding, and setup adapters. */
export type ChannelSetupInput = {
  name?: string;
  token?: string;
  privateKey?: string;
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
  dangerouslyAllowPrivateNetwork?: boolean;
  /** Compatibility alias for legacy setup callers; prefer dangerouslyAllowPrivateNetwork. */
  allowPrivateNetwork?: boolean;
  proxy?: string;
  userId?: string;
  accessToken?: string;
  password?: string;
  deviceName?: string;
  avatarUrl?: string;
  initialSyncLimit?: number;
  ship?: string;
  url?: string;
  relayUrls?: string;
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
  hasActiveWebListener?: (accountId?: string) => boolean;
};

export type ChannelLegacyStateMigrationPlan = {
  kind: "copy" | "move";
  label: string;
  sourcePath: string;
  targetPath: string;
};

/** User-facing metadata used in docs, pickers, and setup surfaces. */
export type ChannelMeta = {
  id: ChannelId;
  label: string;
  selectionLabel: string;
  docsPath: string;
  docsLabel?: string;
  blurb: string;
  order?: number;
  aliases?: readonly string[];
  selectionDocsPrefix?: string;
  selectionDocsOmitLabel?: boolean;
  selectionExtras?: readonly string[];
  detailLabel?: string;
  systemImage?: string;
  markdownCapable?: boolean;
  exposure?: ChannelExposure;
  showConfigured?: boolean;
  showInSetup?: boolean;
  quickstartAllowFrom?: boolean;
  forceAccountBinding?: boolean;
  preferSessionLookupForAnnounceTarget?: boolean;
  preferOver?: readonly string[];
};

/** Snapshot row returned by channel status and lifecycle surfaces. */
export type ChannelAccountSnapshot = {
  accountId: string;
  name?: string;
  enabled?: boolean;
  configured?: boolean;
  linked?: boolean;
  running?: boolean;
  connected?: boolean;
  restartPending?: boolean;
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
  healthState?: string;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  busy?: boolean;
  activeRuns?: number;
  lastRunActivityAt?: number | null;
  mode?: string;
  dmPolicy?: string;
  allowFrom?: string[];
  tokenSource?: string;
  botTokenSource?: string;
  appTokenSource?: string;
  signingSecretSource?: string;
  tokenStatus?: string;
  botTokenStatus?: string;
  appTokenStatus?: string;
  signingSecretStatus?: string;
  userTokenStatus?: string;
  credentialSource?: string;
  secretSource?: string;
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
  publicKey?: string | null;
  profile?: unknown;
  channelAccessToken?: string;
  channelSecret?: string;
};

export type ChannelLogSink = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};

export type ChannelGroupContext = {
  cfg: OpenClawConfig;
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

/** Static capability flags advertised by a channel plugin. */
export type ChannelCapabilities = {
  chatTypes: Array<ChatType | "thread">;
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
  cfg: OpenClawConfig;
  accountId?: string | null;
  account: ResolvedAccount;
};

export type ChannelMentionAdapter = {
  stripRegexes?: (params: {
    ctx: MsgContext;
    cfg: OpenClawConfig | undefined;
    agentId?: string;
  }) => RegExp[];
  stripPatterns?: (params: {
    ctx: MsgContext;
    cfg: OpenClawConfig | undefined;
    agentId?: string;
  }) => string[];
  stripMentions?: (params: {
    text: string;
    ctx: MsgContext;
    cfg: OpenClawConfig | undefined;
    agentId?: string;
  }) => string;
};

export type ChannelStreamingAdapter = {
  blockStreamingCoalesceDefaults?: {
    minChars: number;
    idleMs: number;
  };
};

// Keep core transport-agnostic. Plugins can carry richer component types on
// their side and cast at the boundary.
export type ChannelStructuredComponents = unknown[];

export type ChannelCrossContextComponentsFactory = (params: {
  originLabel: string;
  message: string;
  cfg: OpenClawConfig;
  accountId?: string | null;
}) => ChannelStructuredComponents;

export type ChannelReplyTransport = {
  replyToId?: string | null;
  threadId?: string | number | null;
};

export type ChannelFocusedBindingContext = {
  conversationId: string;
  parentConversationId?: string;
  placement: "current" | "child";
  labelNoun: string;
};

export type ChannelOutboundSessionRoute = {
  sessionKey: string;
  baseSessionKey: string;
  peer: {
    kind: ChatType;
    id: string;
  };
  chatType: "direct" | "group" | "channel";
  from: string;
  to: string;
  threadId?: string | number;
};

export type ChannelThreadingAdapter = {
  resolveReplyToMode?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    chatType?: string | null;
  }) => "off" | "first" | "all" | "batched";
  /**
   * When replyToMode is "off", allow explicit reply tags/directives to keep replyToId.
   *
   * Default in shared reply flow: true for known providers; per-channel opt-out supported.
   */
  allowExplicitReplyTagsWhenOff?: boolean;
  /**
   * Deprecated alias for allowExplicitReplyTagsWhenOff.
   * Kept for compatibility with older plugin surfaces.
   */
  allowTagsWhenOff?: boolean;
  buildToolContext?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    context: ChannelThreadingContext;
    hasRepliedRef?: { value: boolean };
  }) => ChannelThreadingToolContext | undefined;
  resolveAutoThreadId?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    to: string;
    toolContext?: ChannelThreadingToolContext;
    replyToId?: string | null;
  }) => string | undefined;
  resolveReplyTransport?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    threadId?: string | number | null;
    replyToId?: string | null;
  }) => ChannelReplyTransport | null;
  resolveFocusedBinding?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    context: ChannelThreadingContext;
  }) => ChannelFocusedBindingContext | null;
};

export type ChannelThreadingContext = {
  Channel?: string;
  From?: string;
  To?: string;
  ChatType?: string;
  CurrentMessageId?: string | number;
  ReplyToId?: string;
  ReplyToIdFull?: string;
  ThreadLabel?: string;
  MessageThreadId?: string | number;
  /** Platform-native channel/conversation id (e.g. Slack DM channel "D…" id). */
  NativeChannelId?: string;
};

export type ChannelThreadingToolContext = {
  currentChannelId?: string;
  currentGraphChannelId?: string;
  currentChannelProvider?: ChannelId;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  replyToMode?: "off" | "first" | "all" | "batched";
  hasRepliedRef?: { value: boolean };
  /**
   * When true, skip cross-context decoration (e.g., "[from X]" prefix).
   * Use this for direct tool invocations where the agent is composing a new message,
   * not forwarding/relaying a message from another conversation.
   */
  skipCrossContextDecoration?: boolean;
};

/** Channel-owned messaging helpers for target parsing, routing, and payload shaping. */
export type ChannelMessagingAdapter = {
  normalizeTarget?: (raw: string) => string | undefined;
  defaultMarkdownTableMode?: MarkdownTableMode;
  normalizeExplicitSessionKey?: (params: {
    sessionKey: string;
    ctx: MsgContext;
  }) => string | undefined;
  deriveLegacySessionChatType?: (sessionKey: string) => "direct" | "group" | "channel" | undefined;
  isLegacyGroupSessionKey?: (key: string) => boolean;
  canonicalizeLegacySessionKey?: (params: {
    key: string;
    agentId: string;
  }) => string | null | undefined;
  resolveLegacyGroupSessionKey?: (ctx: MsgContext) => {
    key: string;
    channel: string;
    id: string;
    chatType: "group" | "channel";
  } | null;
  resolveInboundAttachmentRoots?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => string[];
  resolveRemoteInboundAttachmentRoots?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => string[];
  resolveInboundConversation?: (params: {
    from?: string;
    to?: string;
    conversationId?: string;
    threadId?: string | number;
    isGroup: boolean;
  }) => {
    conversationId?: string;
    parentConversationId?: string;
  } | null;
  resolveDeliveryTarget?: (params: { conversationId: string; parentConversationId?: string }) => {
    to?: string;
    threadId?: string;
  } | null;
  /**
   * Canonical plugin-owned session conversation grammar.
   * Use this when the provider encodes thread or scoped-conversation semantics
   * inside `rawId` (for example Telegram topics or Feishu sender scopes).
   * Return `baseConversationId` and `parentConversationCandidates` here when
   * you can so parsing and inheritance stay in one place.
   * `parentConversationCandidates`, when present, should be ordered from the
   * narrowest parent to the broadest/base conversation.
   * Bundled plugins that need the same grammar before runtime bootstrap can
   * mirror this contract through a top-level `session-key-api.ts` surface.
   */
  resolveSessionConversation?: (params: { kind: "group" | "channel"; rawId: string }) => {
    id: string;
    threadId?: string | null;
    baseConversationId?: string | null;
    parentConversationCandidates?: string[];
  } | null;
  /**
   * Legacy compatibility hook for parent fallbacks when a plugin does not need
   * to customize `id` or `threadId`. Core only uses this when
   * `resolveSessionConversation(...)` does not return
   * `parentConversationCandidates`.
   */
  resolveParentConversationCandidates?: (params: {
    kind: "group" | "channel";
    rawId: string;
  }) => string[] | null;
  resolveSessionTarget?: (params: {
    kind: "group" | "channel";
    id: string;
    threadId?: string | null;
  }) => string | undefined;
  parseExplicitTarget?: (params: { raw: string }) => {
    to: string;
    threadId?: string | number;
    chatType?: ChatType;
  } | null;
  /**
   * Lightweight chat-type inference used before directory lookup so plugins can
   * steer peer-vs-group resolution without reimplementing host search flow.
   */
  inferTargetChatType?: (params: { to: string }) => ChatType | undefined;
  buildCrossContextComponents?: ChannelCrossContextComponentsFactory;
  transformReplyPayload?: (params: {
    payload: ReplyPayload;
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => ReplyPayload | null;
  enableInteractiveReplies?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => boolean;
  hasStructuredReplyPayload?: (params: { payload: ReplyPayload }) => boolean;
  targetResolver?: {
    looksLikeId?: (raw: string, normalized?: string) => boolean;
    hint?: string;
    /**
     * Plugin-owned fallback for explicit/native targets or post-directory-miss
     * resolution. This should complement directory lookup, not duplicate it.
     */
    resolveTarget?: (params: {
      cfg: OpenClawConfig;
      accountId?: string | null;
      input: string;
      normalized: string;
      preferredKind?: ChannelDirectoryEntryKind | "channel";
    }) => Promise<{
      to: string;
      kind: ChannelDirectoryEntryKind | "channel";
      display?: string;
      source?: "normalized" | "directory";
    } | null>;
  };
  formatTargetDisplay?: (params: {
    target: string;
    display?: string;
    kind?: ChannelDirectoryEntryKind;
  }) => string;
  /**
   * Provider-specific session-route builder used after target resolution.
   * Keep session-key orchestration in core and channel-native routing rules here.
   */
  resolveOutboundSessionRoute?: (params: {
    cfg: OpenClawConfig;
    agentId: string;
    accountId?: string | null;
    target: string;
    currentSessionKey?: string;
    resolvedTarget?: {
      to: string;
      kind: ChannelDirectoryEntryKind | "channel";
      display?: string;
      source: "normalized" | "directory";
    };
    replyToId?: string | null;
    threadId?: string | number | null;
  }) => ChannelOutboundSessionRoute | Promise<ChannelOutboundSessionRoute | null> | null;
};

export type ChannelAgentPromptAdapter = {
  messageToolHints?: (params: { cfg: OpenClawConfig; accountId?: string | null }) => string[];
  messageToolCapabilities?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => string[] | undefined;
  inboundFormattingHints?: (params: { accountId?: string | null }) =>
    | {
        text_markup: string;
        rules: string[];
      }
    | undefined;
  reactionGuidance?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => { level: "minimal" | "extensive"; channelLabel?: string } | undefined;
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

/** Execution context passed to channel-owned actions on the shared `message` tool. */
export type ChannelMessageActionContext = {
  channel: ChannelId;
  action: ChannelMessageActionName;
  cfg: OpenClawConfig;
  params: Record<string, unknown>;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  accountId?: string | null;
  /**
   * Trusted sender id from inbound context. This is server-injected and must
   * never be sourced from tool/model-controlled params.
   */
  requesterSenderId?: string | null;
  senderIsOwner?: boolean;
  sessionKey?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
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
  threadId?: string | null;
};

/** Channel-owned action surface for the shared `message` tool. */
export type ChannelMessageActionAdapter = {
  /**
   * Unified discovery surface for the shared `message` tool.
   * This returns the scoped actions,
   * capabilities, schema fragments, and any plugin-owned media-source params
   * together so they cannot drift.
   */
  describeMessageTool: (
    params: ChannelMessageActionDiscoveryContext,
  ) => ChannelMessageToolDiscovery | null | undefined;
  supportsAction?: (params: { action: ChannelMessageActionName }) => boolean;
  resolveExecutionMode?: (params: { action: ChannelMessageActionName }) => "local" | "gateway";
  resolveCliActionRequest?: (params: {
    action: ChannelMessageActionName;
    args: Record<string, unknown>;
  }) => {
    action: ChannelMessageActionName;
    args: Record<string, unknown>;
  };
  messageActionTargetAliases?: Partial<
    Record<
      ChannelMessageActionName,
      {
        aliases: string[];
      }
    >
  >;
  requiresTrustedRequesterSender?: (params: {
    action: ChannelMessageActionName;
    toolContext?: ChannelThreadingToolContext;
  }) => boolean;
  extractToolSend?: (params: { args: Record<string, unknown> }) => ChannelToolSend | null;
  /**
   * Prefer this for channel-specific poll semantics or extra poll parameters.
   * Core only parses the shared poll model when falling back to `outbound.sendPoll`.
   */
  handleAction?: (ctx: ChannelMessageActionContext) => Promise<AgentToolResult<unknown>>;
};

export type ChannelPollResult = {
  messageId: string;
  toJid?: string;
  channelId?: string;
  conversationId?: string;
  pollId?: string;
};

/** Shared poll input after core has normalized the common poll model. */
export type ChannelPollContext = {
  cfg: OpenClawConfig;
  to: string;
  poll: PollInput;
  accountId?: string | null;
  threadId?: string | null;
  silent?: boolean;
  isAnonymous?: boolean;
  gatewayClientScopes?: readonly string[];
};

/** Minimal base for all channel probe results. Channel-specific probes extend this. */
export type BaseProbeResult<TError = string | null> = {
  ok: boolean;
  error?: TError;
};

/** Minimal base for token resolution results. */
export type BaseTokenResolution = {
  token: string;
  source: string;
};
