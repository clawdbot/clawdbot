import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ClawdbotConfig } from "../../config/config.js";
import type {
  OutboundDeliveryResult,
  OutboundSendDeps,
} from "../../infra/outbound/deliver.js";
import type { PollInput } from "../../polls.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { ChatProviderId } from "../registry.js";

export type ProviderId = ChatProviderId | "msteams";

export type ProviderOutboundTargetMode = "explicit" | "implicit" | "heartbeat";

export type ProviderSetupInput = {
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
  useEnv?: boolean;
};

export type ProviderStatusIssue = {
  provider: ProviderId;
  accountId: string;
  kind: "intent" | "permissions" | "config" | "auth" | "runtime";
  message: string;
  fix?: string;
};

export type ProviderAccountState =
  | "linked"
  | "not linked"
  | "configured"
  | "not configured"
  | "enabled"
  | "disabled";

export type ProviderSetupAdapter = {
  resolveAccountId?: (params: {
    cfg: ClawdbotConfig;
    accountId?: string;
  }) => string;
  applyAccountName?: (params: {
    cfg: ClawdbotConfig;
    accountId: string;
    name?: string;
  }) => ClawdbotConfig;
  applyAccountConfig: (params: {
    cfg: ClawdbotConfig;
    accountId: string;
    input: ProviderSetupInput;
  }) => ClawdbotConfig;
  validateInput?: (params: {
    cfg: ClawdbotConfig;
    accountId: string;
    input: ProviderSetupInput;
  }) => string | null;
};

export type ProviderHeartbeatDeps = {
  webAuthExists?: () => Promise<boolean>;
  hasActiveWebListener?: () => boolean;
};

export type ProviderMeta = {
  id: ProviderId;
  label: string;
  selectionLabel: string;
  docsPath: string;
  docsLabel?: string;
  blurb: string;
  aliases?: string[];
  order?: number;
  showConfigured?: boolean;
  quickstartAllowFrom?: boolean;
  forceAccountBinding?: boolean;
  preferSessionLookupForAnnounceTarget?: boolean;
};

export type ProviderAccountSnapshot = {
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

export type ProviderLogSink = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};

export type ProviderConfigAdapter<ResolvedAccount> = {
  listAccountIds: (cfg: ClawdbotConfig) => string[];
  resolveAccount: (
    cfg: ClawdbotConfig,
    accountId?: string | null,
  ) => ResolvedAccount;
  defaultAccountId?: (cfg: ClawdbotConfig) => string;
  setAccountEnabled?: (params: {
    cfg: ClawdbotConfig;
    accountId: string;
    enabled: boolean;
  }) => ClawdbotConfig;
  deleteAccount?: (params: {
    cfg: ClawdbotConfig;
    accountId: string;
  }) => ClawdbotConfig;
  isEnabled?: (account: ResolvedAccount, cfg: ClawdbotConfig) => boolean;
  disabledReason?: (account: ResolvedAccount, cfg: ClawdbotConfig) => string;
  isConfigured?: (
    account: ResolvedAccount,
    cfg: ClawdbotConfig,
  ) => boolean | Promise<boolean>;
  unconfiguredReason?: (
    account: ResolvedAccount,
    cfg: ClawdbotConfig,
  ) => string;
  describeAccount?: (
    account: ResolvedAccount,
    cfg: ClawdbotConfig,
  ) => ProviderAccountSnapshot;
  resolveAllowFrom?: (params: {
    cfg: ClawdbotConfig;
    accountId?: string | null;
  }) => string[] | undefined;
  formatAllowFrom?: (params: {
    cfg: ClawdbotConfig;
    accountId?: string | null;
    allowFrom: Array<string | number>;
  }) => string[];
};

export type ProviderGroupContext = {
  cfg: ClawdbotConfig;
  groupId?: string | null;
  groupRoom?: string | null;
  groupSpace?: string | null;
  accountId?: string | null;
};

export type ProviderGroupAdapter = {
  resolveRequireMention?: (params: ProviderGroupContext) => boolean | undefined;
};

export type ProviderOutboundContext = {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  mediaUrl?: string;
  gifPlayback?: boolean;
  replyToId?: string | null;
  threadId?: number | null;
  accountId?: string | null;
  deps?: OutboundSendDeps;
};

export type ProviderPollResult = {
  messageId: string;
  toJid?: string;
  channelId?: string;
  conversationId?: string;
  pollId?: string;
};

export type ProviderPollContext = {
  cfg: ClawdbotConfig;
  to: string;
  poll: PollInput;
  accountId?: string | null;
};

export type ProviderOutboundAdapter = {
  deliveryMode: "direct" | "gateway" | "hybrid";
  chunker?: ((text: string, limit: number) => string[]) | null;
  textChunkLimit?: number;
  pollMaxOptions?: number;
  resolveTarget?: (params: {
    cfg?: ClawdbotConfig;
    to?: string;
    allowFrom?: string[];
    accountId?: string | null;
    mode?: ProviderOutboundTargetMode;
  }) => { ok: true; to: string } | { ok: false; error: Error };
  sendText?: (ctx: ProviderOutboundContext) => Promise<OutboundDeliveryResult>;
  sendMedia?: (ctx: ProviderOutboundContext) => Promise<OutboundDeliveryResult>;
  sendPoll?: (ctx: ProviderPollContext) => Promise<ProviderPollResult>;
};

export type ProviderStatusAdapter<ResolvedAccount> = {
  defaultRuntime?: ProviderAccountSnapshot;
  buildProviderSummary?: (params: {
    account: ResolvedAccount;
    cfg: ClawdbotConfig;
    defaultAccountId: string;
    snapshot: ProviderAccountSnapshot;
  }) => Record<string, unknown> | Promise<Record<string, unknown>>;
  probeAccount?: (params: {
    account: ResolvedAccount;
    timeoutMs: number;
    cfg: ClawdbotConfig;
  }) => Promise<unknown>;
  auditAccount?: (params: {
    account: ResolvedAccount;
    timeoutMs: number;
    cfg: ClawdbotConfig;
    probe?: unknown;
  }) => Promise<unknown>;
  buildAccountSnapshot?: (params: {
    account: ResolvedAccount;
    cfg: ClawdbotConfig;
    runtime?: ProviderAccountSnapshot;
    probe?: unknown;
    audit?: unknown;
  }) => ProviderAccountSnapshot | Promise<ProviderAccountSnapshot>;
  logSelfId?: (params: {
    account: ResolvedAccount;
    cfg: ClawdbotConfig;
    runtime: RuntimeEnv;
    includeProviderPrefix?: boolean;
  }) => void;
  resolveAccountState?: (params: {
    account: ResolvedAccount;
    cfg: ClawdbotConfig;
    configured: boolean;
    enabled: boolean;
  }) => ProviderAccountState;
  collectStatusIssues?: (
    accounts: ProviderAccountSnapshot[],
  ) => ProviderStatusIssue[];
};

export type ProviderGatewayContext<ResolvedAccount = unknown> = {
  cfg: ClawdbotConfig;
  accountId: string;
  account: ResolvedAccount;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  log?: ProviderLogSink;
  getStatus: () => ProviderAccountSnapshot;
  setStatus: (next: ProviderAccountSnapshot) => void;
};

export type ProviderLogoutResult = {
  cleared: boolean;
  loggedOut?: boolean;
  [key: string]: unknown;
};

export type ProviderLogoutContext<ResolvedAccount = unknown> = {
  cfg: ClawdbotConfig;
  accountId: string;
  account: ResolvedAccount;
  runtime: RuntimeEnv;
  log?: ProviderLogSink;
};

export type ProviderPairingAdapter = {
  idLabel: string;
  normalizeAllowEntry?: (entry: string) => string;
  notifyApproval?: (params: {
    cfg: ClawdbotConfig;
    id: string;
    runtime?: RuntimeEnv;
  }) => Promise<void>;
};

export type ProviderGatewayAdapter<ResolvedAccount = unknown> = {
  startAccount?: (
    ctx: ProviderGatewayContext<ResolvedAccount>,
  ) => Promise<unknown>;
  stopAccount?: (ctx: ProviderGatewayContext<ResolvedAccount>) => Promise<void>;
  logoutAccount?: (
    ctx: ProviderLogoutContext<ResolvedAccount>,
  ) => Promise<ProviderLogoutResult>;
};

export type ProviderHeartbeatAdapter = {
  checkReady?: (params: {
    cfg: ClawdbotConfig;
    accountId?: string | null;
    deps?: ProviderHeartbeatDeps;
  }) => Promise<{ ok: boolean; reason: string }>;
};

export type ProviderCapabilities = {
  chatTypes: Array<"direct" | "group" | "channel" | "thread">;
  polls?: boolean;
  reactions?: boolean;
  threads?: boolean;
  media?: boolean;
  nativeCommands?: boolean;
  blockStreaming?: boolean;
};

export type ProviderElevatedAdapter = {
  allowFromFallback?: (params: {
    cfg: ClawdbotConfig;
    accountId?: string | null;
  }) => Array<string | number> | undefined;
};

export type ProviderCommandAdapter = {
  enforceOwnerForCommands?: boolean;
  skipWhenConfigEmpty?: boolean;
};

export type ProviderStreamingAdapter = {
  blockStreamingCoalesceDefaults?: {
    minChars: number;
    idleMs: number;
  };
};

export type ProviderThreadingAdapter = {
  resolveReplyToMode?: (params: {
    cfg: ClawdbotConfig;
    accountId?: string | null;
  }) => "off" | "first" | "all";
  allowTagsWhenOff?: boolean;
  buildToolContext?: (params: {
    cfg: ClawdbotConfig;
    accountId?: string | null;
    context: ProviderThreadingContext;
    hasRepliedRef?: { value: boolean };
  }) => ProviderThreadingToolContext | undefined;
};

export type ProviderThreadingContext = {
  Provider?: string;
  To?: string;
  ReplyToId?: string;
  ThreadLabel?: string;
};

export type ProviderThreadingToolContext = {
  currentChannelId?: string;
  currentThreadTs?: string;
  replyToMode?: "off" | "first" | "all";
  hasRepliedRef?: { value: boolean };
};

export type ProviderMessagingAdapter = {
  normalizeTarget?: (raw: string) => string | undefined;
};

export type ProviderMessageActionName =
  | "send"
  | "poll"
  | "react"
  | "reactions"
  | "read"
  | "edit"
  | "delete"
  | "pin"
  | "unpin"
  | "list-pins"
  | "permissions"
  | "thread-create"
  | "thread-list"
  | "thread-reply"
  | "search"
  | "sticker"
  | "member-info"
  | "role-info"
  | "emoji-list"
  | "emoji-upload"
  | "sticker-upload"
  | "role-add"
  | "role-remove"
  | "channel-info"
  | "channel-list"
  | "voice-status"
  | "event-list"
  | "event-create"
  | "timeout"
  | "kick"
  | "ban";

export type ProviderMessageActionContext = {
  provider: ProviderId;
  action: ProviderMessageActionName;
  cfg: ClawdbotConfig;
  params: Record<string, unknown>;
  accountId?: string | null;
  gateway?: {
    url?: string;
    token?: string;
    timeoutMs?: number;
    clientName: "cli" | "agent";
    mode: "cli" | "agent";
  };
  toolContext?: ProviderThreadingToolContext;
  dryRun?: boolean;
};

export type ProviderMessageActionAdapter = {
  listActions?: (params: {
    cfg: ClawdbotConfig;
  }) => ProviderMessageActionName[];
  supportsAction?: (params: { action: ProviderMessageActionName }) => boolean;
  supportsButtons?: (params: { cfg: ClawdbotConfig }) => boolean;
  handleAction?: (
    ctx: ProviderMessageActionContext,
  ) => Promise<AgentToolResult<unknown>>;
};

// biome-ignore lint/suspicious/noExplicitAny: registry aggregates heterogeneous account types.
export type ProviderPlugin<ResolvedAccount = any> = {
  id: ProviderId;
  meta: ProviderMeta;
  capabilities: ProviderCapabilities;
  reload?: { configPrefixes: string[]; noopPrefixes?: string[] };
  config: ProviderConfigAdapter<ResolvedAccount>;
  setup?: ProviderSetupAdapter;
  pairing?: ProviderPairingAdapter;
  groups?: ProviderGroupAdapter;
  outbound?: ProviderOutboundAdapter;
  status?: ProviderStatusAdapter<ResolvedAccount>;
  gatewayMethods?: string[];
  gateway?: ProviderGatewayAdapter<ResolvedAccount>;
  elevated?: ProviderElevatedAdapter;
  commands?: ProviderCommandAdapter;
  streaming?: ProviderStreamingAdapter;
  threading?: ProviderThreadingAdapter;
  messaging?: ProviderMessagingAdapter;
  actions?: ProviderMessageActionAdapter;
  heartbeat?: ProviderHeartbeatAdapter;
};
