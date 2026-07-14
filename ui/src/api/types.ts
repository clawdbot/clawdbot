// Control UI type declarations define types contracts.
export type UpdateAvailable = import("../../../src/infra/update-startup.js").UpdateAvailable;
import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import type { SessionGoal } from "../../../src/config/sessions/types.js";
import type { CronJobBase } from "../../../src/cron/types-shared.js";
import type { ConfigUiHints } from "../../../src/shared/config-ui-hints-types.js";
import type { FastModeSource } from "../../../src/shared/fast-mode.js";
import type {
  GatewayAgentRuntime,
  GatewayAgentRow as SharedGatewayAgentRow,
  SessionsListResultBase,
  SessionsPatchResultBase,
} from "../../../src/shared/session-types.js";
export type { ConfigUiHint, ConfigUiHints } from "../../../src/shared/config-ui-hints-types.js";
export type { SessionGoal } from "../../../src/config/sessions/types.js";
export type { FastMode } from "@openclaw/normalization-core/string-coerce";
export type ChannelsStatusSnapshot = {
  ts: number;
  channelOrder: string[];
  channelLabels: Record<string, string>;
  channelDetailLabels?: Record<string, string>;
  channelSystemImages?: Record<string, string>;
  channelMeta?: ChannelUiMetaEntry[];
  channels: Record<string, unknown>;
  channelAccounts: Record<string, ChannelAccountSnapshot[]>;
  channelDefaultAccountId: Record<string, string>;
  partial?: boolean;
  warnings?: string[];
};

export type ChannelUiMetaEntry = {
  id: string;
  label: string;
  detailLabel: string;
  systemImage?: string;
};

export type ChannelAccountSnapshot = {
  accountId: string;
  name?: string | null;
  enabled?: boolean | null;
  configured?: boolean | null;
  linked?: boolean | null;
  running?: boolean | null;
  connected?: boolean | null;
  reconnectAttempts?: number | null;
  lastConnectedAt?: number | null;
  lastError?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  lastProbeAt?: number | null;
  mode?: string | null;
  dmPolicy?: string | null;
  allowFrom?: string[] | null;
  tokenSource?: string | null;
  botTokenSource?: string | null;
  appTokenSource?: string | null;
  credentialSource?: string | null;
  audienceType?: string | null;
  audience?: string | null;
  webhookPath?: string | null;
  webhookUrl?: string | null;
  baseUrl?: string | null;
  allowUnmentionedGroups?: boolean | null;
  cliPath?: string | null;
  dbPath?: string | null;
  port?: number | null;
  probe?: unknown;
  audit?: unknown;
  application?: unknown;
};

type WhatsAppSelf = {
  e164?: string | null;
  jid?: string | null;
};

type WhatsAppDisconnect = {
  at: number;
  status?: number | null;
  error?: string | null;
  loggedOut?: boolean | null;
};

export type WhatsAppStatus = {
  configured: boolean;
  linked: boolean;
  authAgeMs?: number | null;
  self?: WhatsAppSelf | null;
  running: boolean;
  connected: boolean;
  lastConnectedAt?: number | null;
  lastDisconnect?: WhatsAppDisconnect | null;
  reconnectAttempts: number;
  lastMessageAt?: number | null;
  lastEventAt?: number | null;
  lastError?: string | null;
};

type TelegramBot = {
  id?: number | null;
  username?: string | null;
};

type TelegramWebhook = {
  url?: string | null;
  hasCustomCert?: boolean | null;
};

type TelegramProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs?: number | null;
  bot?: TelegramBot | null;
  webhook?: TelegramWebhook | null;
};

export type TelegramStatus = {
  configured: boolean;
  tokenSource?: string | null;
  running: boolean;
  mode?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: TelegramProbe | null;
  lastProbeAt?: number | null;
};

type DiscordBot = {
  id?: string | null;
  username?: string | null;
};

type DiscordProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs?: number | null;
  bot?: DiscordBot | null;
};

export type DiscordStatus = {
  configured: boolean;
  tokenSource?: string | null;
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: DiscordProbe | null;
  lastProbeAt?: number | null;
};

type GoogleChatProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs?: number | null;
};

export type GoogleChatStatus = {
  configured: boolean;
  credentialSource?: string | null;
  audienceType?: string | null;
  audience?: string | null;
  webhookPath?: string | null;
  webhookUrl?: string | null;
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: GoogleChatProbe | null;
  lastProbeAt?: number | null;
};

type SlackBot = {
  id?: string | null;
  name?: string | null;
};

type SlackTeam = {
  id?: string | null;
  name?: string | null;
};

type SlackProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs?: number | null;
  bot?: SlackBot | null;
  team?: SlackTeam | null;
};

export type SlackStatus = {
  configured: boolean;
  botTokenSource?: string | null;
  appTokenSource?: string | null;
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: SlackProbe | null;
  lastProbeAt?: number | null;
};

type SignalProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs?: number | null;
  version?: string | null;
};

export type SignalStatus = {
  configured: boolean;
  baseUrl: string;
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: SignalProbe | null;
  lastProbeAt?: number | null;
};

type IMessageProbe = {
  ok: boolean;
  error?: string | null;
};

export type IMessageStatus = {
  configured: boolean;
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  cliPath?: string | null;
  dbPath?: string | null;
  probe?: IMessageProbe | null;
  lastProbeAt?: number | null;
};

export type NostrProfile = {
  name?: string | null;
  displayName?: string | null;
  about?: string | null;
  picture?: string | null;
  banner?: string | null;
  website?: string | null;
  nip05?: string | null;
  lud16?: string | null;
};

export type NostrStatus = {
  configured: boolean;
  publicKey?: string | null;
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  profile?: NostrProfile | null;
};

type ConfigSnapshotIssue = {
  path: string;
  message: string;
};

export type ConfigSnapshot = {
  path?: string | null;
  exists?: boolean | null;
  raw?: string | null;
  hash?: string | null;
  parsed?: unknown;
  valid?: boolean | null;
  sourceConfig?: Record<string, unknown> | null;
  resolved?: Record<string, unknown> | null;
  runtimeConfig?: Record<string, unknown> | null;
  config?: Record<string, unknown> | null;
  issues?: ConfigSnapshotIssue[] | null;
};

export type ConfigSchemaResponse = {
  schema: unknown;
  uiHints: ConfigUiHints;
  version: string;
  generatedAt: string;
};

export type PresenceEntry = {
  deviceId?: string | null;
  instanceId?: string | null;
  host?: string | null;
  ip?: string | null;
  version?: string | null;
  platform?: string | null;
  deviceFamily?: string | null;
  modelIdentifier?: string | null;
  roles?: string[] | null;
  scopes?: string[] | null;
  mode?: string | null;
  lastInputSeconds?: number | null;
  reason?: string | null;
  text?: string | null;
  ts?: number | null;
};

export type GatewaySessionsDefaults = {
  modelProvider: string | null;
  model: string | null;
  contextTokens: number | null;
  agentRuntime?: GatewayAgentRuntime;
  thinkingLevels?: GatewayThinkingLevelOption[];
  thinkingOptions?: string[];
  thinkingDefault?: string;
};

export type GatewayThinkingLevelOption = {
  id: string;
  label: string;
};

export type GatewayAgentRow = SharedGatewayAgentRow;

export type AgentsListResult = {
  defaultId: string;
  mainKey: string;
  scope: string;
  agents: GatewayAgentRow[];
};

export type AgentIdentityResult = {
  agentId: string;
  name: string;
  avatar: string;
  avatarSource?: string | null;
  avatarStatus?: "none" | "local" | "remote" | "data" | null;
  avatarReason?: string | null;
  emoji?: string;
};

export type AgentFileEntry = {
  name: string;
  path: string;
  missing: boolean;
  size?: number;
  updatedAtMs?: number;
  content?: string;
};

export type AgentsFilesListResult = {
  agentId: string;
  workspace: string;
  files: AgentFileEntry[];
};

export type AgentsFilesGetResult = {
  agentId: string;
  workspace: string;
  file: AgentFileEntry;
};

export type AgentsFilesSetResult = {
  ok: true;
  agentId: string;
  workspace: string;
  file: AgentFileEntry;
};

type SessionWorkspaceFileEntry = {
  path: string;
  workspacePath?: string;
  name: string;
  kind: "modified" | "read";
  missing: boolean;
  size?: number;
  updatedAtMs?: number;
  content?: string;
  /** sha256 hex of the file bytes; the CAS token for sessions.files.set. */
  hash?: string;
};

type SessionWorkspaceBrowserEntry = {
  path: string;
  name: string;
  kind: "file" | "directory";
  sessionKind?: "modified" | "read" | "mixed";
  size?: number;
  updatedAtMs?: number;
};

type SessionWorkspaceBrowserResult = {
  path: string;
  parentPath?: string;
  search?: string;
  entries: SessionWorkspaceBrowserEntry[];
  truncated?: boolean;
};

type SessionWorkspaceArtifactEntry = {
  id: string;
  type: string;
  title: string;
  mimeType?: string;
  sizeBytes?: number;
  source?: string;
  download: {
    mode: "bytes" | "url" | "unsupported";
  };
};

export type SessionWorkspaceListResult = {
  sessionKey: string;
  root?: string;
  files: SessionWorkspaceFileEntry[];
  browser?: SessionWorkspaceBrowserResult;
  artifacts?: SessionWorkspaceArtifactEntry[];
};

export type SessionWorkspaceGetResult = {
  sessionKey: string;
  root?: string;
  file: SessionWorkspaceFileEntry;
};

export type SessionWorkspaceSetResult = {
  sessionKey: string;
  root?: string;
  file: SessionWorkspaceFileEntry;
};

export type ArtifactDownloadResult = {
  artifact: SessionWorkspaceArtifactEntry;
  encoding?: "base64";
  data?: string;
  url?: string;
};

export type SessionRunStatus = "running" | "done" | "failed" | "killed" | "timeout";
type SubagentRunState = "active" | "interrupted" | "historical";

type SessionCompactionCheckpointReason =
  | "manual"
  | "auto-threshold"
  | "overflow-retry"
  | "timeout-retry";

type SessionCompactionTranscriptReference = {
  sessionId: string;
  sessionFile?: string;
  leafId?: string;
  entryId?: string;
};

export type SessionCompactionCheckpoint = {
  checkpointId: string;
  sessionKey: string;
  sessionId: string;
  createdAt: number;
  reason: SessionCompactionCheckpointReason;
  tokensBefore?: number;
  tokensAfter?: number;
  summary?: string;
  firstKeptEntryId?: string;
  preCompaction: SessionCompactionTranscriptReference;
  postCompaction: SessionCompactionTranscriptReference;
};

type SessionCompactionCheckpointPreview = Pick<
  SessionCompactionCheckpoint,
  "checkpointId" | "createdAt" | "reason"
>;

export type GatewaySessionRow = {
  key: string;
  spawnedBy?: string;
  /** Managed worktree bound to this session (repo checkout + branch). */
  worktree?: { id: string; branch: string; repoRoot: string };
  /** Session-scoped exec node binding (exec host=node routing). */
  execNode?: string;
  kind: "cron" | "direct" | "group" | "global" | "unknown";
  label?: string;
  /** User-defined organization bucket; unrelated to chat-group kind/groupChannel. */
  category?: string;
  displayName?: string;
  channel?: string;
  surface?: string;
  subject?: string;
  room?: string;
  space?: string;
  updatedAt: number | null;
  unread?: boolean;
  lastReadAt?: number;
  lastActivityAt?: number;
  archived?: boolean;
  archivedAt?: number;
  pinned?: boolean;
  pinnedAt?: number;
  sessionId?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  thinkingLevel?: string;
  thinkingLevels?: GatewayThinkingLevelOption[];
  thinkingOptions?: string[];
  thinkingDefault?: string;
  fastMode?: FastMode;
  effectiveFastMode?: FastMode;
  effectiveFastModeSource?: FastModeSource;
  fastAutoOnSeconds?: number;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  estimatedCostUsd?: number;
  status?: SessionRunStatus;
  hasActiveRun?: boolean;
  activeRunIds?: string[];
  /** An enabled cron job is bound to this session (runs in it or delivers to it). */
  hasAutomation?: boolean;
  subagentRunState?: SubagentRunState;
  hasActiveSubagentRun?: boolean;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  childSessions?: string[];
  model?: string;
  modelProvider?: string;
  modelSelectionLocked?: boolean;
  effectiveResponseUsage?: "on" | "off" | "tokens" | "full";
  agentRuntime?: GatewayAgentRuntime;
  contextTokens?: number;
  compactionCheckpointCount?: number;
  latestCompactionCheckpoint?: SessionCompactionCheckpointPreview;
  goal?: SessionGoal;
};

export type SessionsListResult = SessionsListResultBase<GatewaySessionsDefaults, GatewaySessionRow>;

export type SessionsCompactionListResult = {
  ok: true;
  key: string;
  checkpoints: SessionCompactionCheckpoint[];
};

export type SessionsCompactionBranchResult = {
  ok: true;
  sourceKey: string;
  key: string;
  sessionId: string;
  checkpoint: SessionCompactionCheckpoint;
  entry: {
    sessionId: string;
    updatedAt: number;
  } & Record<string, unknown>;
};

export type SessionsCompactionRestoreResult = {
  ok: true;
  key: string;
  sessionId: string;
  checkpoint: SessionCompactionCheckpoint;
  entry: {
    sessionId: string;
    updatedAt: number;
  } & Record<string, unknown>;
};

export type SessionsPatchResult = SessionsPatchResultBase<{
  sessionId: string;
  updatedAt?: number;
  thinkingLevel?: string;
  fastMode?: FastMode;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
}> & {
  resolved?: {
    modelProvider?: string;
    model?: string;
    agentRuntime?: GatewayAgentRuntime;
    thinkingLevel?: string;
    thinkingLevels?: GatewayThinkingLevelOption[];
  };
};

export type {
  CostUsageSummary,
  SessionsUsageResult,
  SessionUsageTimeSeries,
} from "../pages/usage/data-types.ts";

export type CronRunStatus = "ok" | "error" | "skipped";
export type CronDeliveryStatus = "delivered" | "not-delivered" | "unknown" | "not-requested";
export type CronJobsEnabledFilter = "all" | "enabled" | "disabled";
export type CronJobsSortBy = "nextRunAtMs" | "updatedAtMs" | "name";
export type CronRunScope = "job" | "all";
export type CronRunsStatusValue = CronRunStatus;
export type CronRunsStatusFilter = "all" | CronRunStatus;
export type CronSortDir = "asc" | "desc";

type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number }
  | { kind: "on-exit"; command: string; cwd?: string };

type CronSessionTarget = "main" | "isolated" | "current" | `session:${string}`;
type CronWakeMode = "next-heartbeat" | "now";

export type CronPayload =
  | { kind: "systemEvent"; text: string }
  | {
      kind: "command";
      argv: string[];
      cwd?: string;
      env?: Record<string, string>;
      input?: string;
      timeoutSeconds?: number;
      noOutputTimeoutSeconds?: number;
      outputMaxBytes?: number;
    }
  | {
      kind: "agentTurn";
      message: string;
      model?: string;
      fallbacks?: string[];
      thinking?: string;
      timeoutSeconds?: number;
      allowUnsafeExternalContent?: boolean;
      lightContext?: boolean;
      deliver?: boolean;
      channel?: string;
      to?: string;
      bestEffortDeliver?: boolean;
    };

type CronDelivery = {
  mode: "none" | "announce" | "webhook";
  channel?: string;
  to?: string;
  accountId?: string;
  bestEffort?: boolean;
  failureDestination?: CronFailureDestination;
};

type CronFailureDestination = {
  channel?: string;
  to?: string;
  mode?: "announce" | "webhook";
  accountId?: string;
};

type CronFailureAlert = {
  after?: number;
  channel?: string;
  to?: string;
  cooldownMs?: number;
  mode?: "announce" | "webhook";
  accountId?: string;
};

type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: CronRunStatus;
  lastStatus?: CronRunStatus;
  lastError?: string;
  lastErrorReason?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;
  lastDelivered?: boolean;
  lastDeliveryStatus?: CronDeliveryStatus;
  lastDeliveryError?: string;
  lastFailureNotificationDelivered?: boolean;
  lastFailureNotificationDeliveryStatus?: CronDeliveryStatus;
  lastFailureNotificationDeliveryError?: string;
  lastFailureAlertAtMs?: number;
};

export type CronJob = CronJobBase<
  CronSchedule,
  CronSessionTarget,
  CronWakeMode,
  CronPayload,
  CronDelivery,
  CronFailureAlert | false
> & {
  state?: CronJobState;
};

export type CronStatus = {
  enabled: boolean;
  jobs: number;
  nextWakeAtMs?: number | null;
};

export type CronRunResult =
  | { ok: true; ran: true }
  | { ok: true; enqueued: true; runId: string }
  | {
      ok: true;
      ran: false;
      reason:
        | "not-due"
        | "already-running"
        | "restart-recovery-pending"
        | "invalid-spec"
        | "stopped";
    }
  | { ok: false };

export type CronRunLogEntry = {
  ts: number;
  jobId: string;
  action?: "finished";
  status?: CronRunStatus;
  durationMs?: number;
  error?: string;
  summary?: string;
  delivered?: boolean;
  deliveryStatus?: CronDeliveryStatus;
  deliveryError?: string;
  sessionId?: string;
  sessionKey?: string;
  runAtMs?: number;
  nextRunAtMs?: number;
  model?: string;
  provider?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
  jobName?: string;
};

export type CronJobsListResult = {
  jobs: CronJob[];
  total?: number;
  limit?: number;
  offset?: number;
  nextOffset?: number | null;
  hasMore?: boolean;
};

export type CronRunsResult = {
  entries: CronRunLogEntry[];
  total?: number;
  limit?: number;
  offset?: number;
  nextOffset?: number | null;
  hasMore?: boolean;
};

type SkillsStatusConfigCheck = {
  path: string;
  satisfied: boolean;
};

type SkillInstallOption = {
  id: string;
  kind: "brew" | "node" | "go" | "uv" | "download";
  label: string;
  bins: string[];
};

export type SkillClawHubLink =
  | {
      status: "linked";
      valid: true;
      registry: string;
      slug: string;
      installedVersion: string;
      installedAt: number;
      originPath?: string;
      lockPath?: string;
    }
  | {
      status: "invalid";
      valid: false;
      reason: string;
      registry?: string;
      slug?: string;
      installedVersion?: string;
      installedAt?: number;
      originPath?: string;
      lockPath?: string;
    };

type SkillCardStatus = {
  present: true;
  path: string;
  sizeBytes: number;
};

export type SkillStatusEntry = {
  name: string;
  description: string;
  source: string;
  filePath: string;
  baseDir: string;
  skillKey: string;
  bundled?: boolean;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  always: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  blockedByAgentFilter?: boolean;
  eligible: boolean;
  modelVisible?: boolean;
  userInvocable?: boolean;
  commandVisible?: boolean;
  requirements: {
    anyBins?: string[];
    bins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  missing: {
    bins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  configChecks: SkillsStatusConfigCheck[];
  install: SkillInstallOption[];
  clawhub?: SkillClawHubLink;
  skillCard?: SkillCardStatus;
};

export type SkillStatusReport = {
  workspaceDir: string;
  managedSkillsDir: string;
  agentId?: string;
  agentSkillFilter?: string[];
  skills: SkillStatusEntry[];
};

export type StatusSummary = Record<string, unknown>;

export type HealthSnapshot = Record<string, unknown>;

/** A model entry returned by the gateway model-catalog endpoint. */
export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  alias?: string;
  available?: boolean;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image" | "document">;
  apiKeySupported?: boolean;
};

export type ToolCatalogProfile =
  import("../../../packages/gateway-protocol/src/schema.js").ToolCatalogProfile;
export type ToolsCatalogResult =
  import("../../../packages/gateway-protocol/src/schema.js").ToolsCatalogResult;
export type ToolsEffectiveEntry =
  import("../../../packages/gateway-protocol/src/schema.js").ToolsEffectiveEntry;
export type ToolsEffectiveResult =
  import("../../../packages/gateway-protocol/src/schema.js").ToolsEffectiveResult;

export type ModelAuthStatusProvider =
  import("../../../src/gateway/server-methods/models-auth-status.js").ModelAuthStatusProvider;
export type ModelAuthStatusProfile =
  import("../../../src/gateway/server-methods/models-auth-status.js").ModelAuthStatusProfile;
export type ModelAuthStatusResult =
  import("../../../src/gateway/server-methods/models-auth-status.js").ModelAuthStatusResult;
export type ModelsProbeResult =
  import("../../../packages/gateway-protocol/src/schema.js").ModelsProbeResult;
