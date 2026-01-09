import type { ClawdbotConfig } from "../../config/config.js";
import type {
  OutboundDeliveryResult,
  OutboundSendDeps,
} from "../../infra/outbound/deliver.js";
import type { PollInput } from "../../polls.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { ChatProviderId } from "../registry.js";

export type ProviderId = ChatProviderId | "msteams";

export type ProviderMeta = {
  id: ProviderId;
  label: string;
  selectionLabel: string;
  docsPath: string;
  docsLabel?: string;
  blurb: string;
  aliases?: string[];
  order?: number;
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

export type ProviderConfigAdapter<ResolvedAccount> = {
  listAccountIds: (cfg: ClawdbotConfig) => string[];
  resolveAccount: (
    cfg: ClawdbotConfig,
    accountId?: string | null,
  ) => ResolvedAccount;
  defaultAccountId?: (cfg: ClawdbotConfig) => string;
  isConfigured?: (
    account: ResolvedAccount,
    cfg: ClawdbotConfig,
  ) => boolean | Promise<boolean>;
  describeAccount?: (
    account: ResolvedAccount,
    cfg: ClawdbotConfig,
  ) => ProviderAccountSnapshot;
};

export type ProviderOutboundContext = {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  mediaUrl?: string;
  gifPlayback?: boolean;
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
  pollMaxOptions?: number;
  resolveTarget?: (params: {
    cfg?: ClawdbotConfig;
    to?: string;
    allowFrom?: string[];
  }) => { ok: true; to: string } | { ok: false; error: Error };
  sendText?: (ctx: ProviderOutboundContext) => Promise<OutboundDeliveryResult>;
  sendMedia?: (ctx: ProviderOutboundContext) => Promise<OutboundDeliveryResult>;
  sendPoll?: (ctx: ProviderPollContext) => Promise<ProviderPollResult>;
};

export type ProviderStatusAdapter<ResolvedAccount> = {
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
};

export type ProviderGatewayContext<ResolvedAccount = unknown> = {
  cfg: ClawdbotConfig;
  accountId: string;
  account: ResolvedAccount;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  getStatus: () => ProviderAccountSnapshot;
  setStatus: (next: ProviderAccountSnapshot) => void;
};

export type ProviderGatewayAdapter<ResolvedAccount = unknown> = {
  startAccount?: (
    ctx: ProviderGatewayContext<ResolvedAccount>,
  ) => Promise<unknown>;
  stopAccount?: (ctx: ProviderGatewayContext<ResolvedAccount>) => Promise<void>;
};

export type ProviderCapabilities = {
  chatTypes: Array<"direct" | "group" | "channel" | "thread">;
  polls?: boolean;
  reactions?: boolean;
  threads?: boolean;
  media?: boolean;
};

// biome-ignore lint/suspicious/noExplicitAny: registry aggregates heterogeneous account types.
export type ProviderPlugin<ResolvedAccount = any> = {
  id: ProviderId;
  meta: ProviderMeta;
  capabilities: ProviderCapabilities;
  reload?: { configPrefixes: string[] };
  config: ProviderConfigAdapter<ResolvedAccount>;
  outbound?: ProviderOutboundAdapter;
  status?: ProviderStatusAdapter<ResolvedAccount>;
  gateway?: ProviderGatewayAdapter<ResolvedAccount>;
};
