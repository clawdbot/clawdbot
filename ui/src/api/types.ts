export type {
  UpdateAvailable,
  UpdateHoldResult,
  UpdateScheduleState,
} from "../../../packages/gateway-protocol/src/index.js";
import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import type { AgentsListResult as ProtocolAgentsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { ChannelsStatusResult } from "../../../packages/gateway-protocol/src/schema/channels.js";
import type { QueueMode } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { SessionRow } from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { PresenceEntry as ProtocolPresenceEntry } from "../../../packages/gateway-protocol/src/schema/snapshot.js";
import type { SessionAgentStatus } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import type { SessionGoal } from "../../../src/config/sessions/types.js";
import type { CronJobBase } from "../../../src/cron/types-shared.js";
import type { CronPayload as CoreCronPayload } from "../../../src/cron/types.js";
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
export type ChannelsPairingAccount =
  import("../../../packages/gateway-protocol/src/index.js").ChannelsPairingAccount;
export type ChannelsPairingApproveResult =
  import("../../../packages/gateway-protocol/src/index.js").ChannelsPairingApproveResult;
export type ChannelsPairingListResult =
  import("../../../packages/gateway-protocol/src/index.js").ChannelsPairingListResult;
export type ChannelsPairingRequest =
  import("../../../packages/gateway-protocol/src/index.js").ChannelsPairingRequest;
export type SessionVisibility =
  import("../../../packages/gateway-protocol/src/index.js").SessionVisibility;
export type SessionMembersListResult =
  import("../../../packages/gateway-protocol/src/index.js").SessionMembersListResult;
export type { SessionRunStatus } from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
export type ChannelsStatusSnapshot = ChannelsStatusResult;
export type ChannelUiMetaEntry = NonNullable<ChannelsStatusResult["channelMeta"]>[number];
export type ChannelAccountSnapshot = ChannelsStatusResult["channelAccounts"][string][number];

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

type ConfigSnapshotIssue = { path: string; message: string };

export type ConfigSnapshot = {
  path?: string | null;
  exists?: boolean | null;
  raw?: string | null;
  hash?: string | null;
  configRevisionHash?: string | null;
  appliedConfigHash?: string | null;
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

export type PresenceEntry = ProtocolPresenceEntry;

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

export type AgentsListResult = ProtocolAgentsListResult;

export type AgentIdentityResult = {
  agentId: string;
  name: string;
  nameSource?: "config" | "agent" | "workspace" | "default";
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
  // Absence is a normal workspace state (optional profile files, MEMORY.md before
  // anything is written); the editor offers these for creation instead of flagging them.
  expectedAbsent?: boolean;
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
  mimeType?: string;
  contentEncoding?: "utf8" | "base64";
  previewKind?: "text" | "image" | "unsupported";
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
  gitCheckout?: boolean;
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
  expiresAt?: string;
};

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

export type GatewaySessionRow = SessionRow & {
  placement?: import("../../../packages/gateway-protocol/src/index.js").SessionPlacement;
  icon?: string;
  /** User-defined organization bucket; unrelated to chat-group kind/groupChannel. */
  category?: string;
  surface?: string;
  subject?: string;
  room?: string;
  space?: string;
  agentStatus?: SessionAgentStatus;
  observerDigest?: Pick<
    SessionObserverDigest,
    "agentId" | "runId" | "headline" | "health" | "updatedAt" | "revision"
  >;
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
  hasActiveRun?: boolean;
  activeRunIds?: string[];
  /** An enabled cron job is bound to this session (runs in it or delivers to it). */
  hasAutomation?: boolean;
  subagentRunState?: SubagentRunState;
  hasActiveSubagentRun?: boolean;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  /** UI-local timestamp for the runtimeMs sample; absent on raw Gateway rows. */
  runtimeSampledAt?: number;
  modelSelectionLocked?: boolean;
  effectiveResponseUsage?: "on" | "off" | "tokens" | "full";
  queueMode?: QueueMode;
  effectiveQueueMode?: QueueMode;
  agentRuntime?: GatewayAgentRuntime;
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

export type SessionsRewindResult =
  import("../../../packages/gateway-protocol/src/index.js").SessionsRewindResult;
export type SessionsForkResult =
  import("../../../packages/gateway-protocol/src/index.js").SessionsForkResult;
export type SessionBranch = import("../../../packages/gateway-protocol/src/index.js").SessionBranch;
export type SessionsBranchesListResult =
  import("../../../packages/gateway-protocol/src/index.js").SessionsBranchesListResult;
export type SessionsBranchesSwitchResult =
  import("../../../packages/gateway-protocol/src/index.js").SessionsBranchesSwitchResult;

export type SessionsPatchResult = SessionsPatchResultBase<{
  sessionId: string;
  updatedAt?: number;
  archivedAt?: number;
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
  | { kind: "on-exit"; command: string; cwd?: string }
  | {
      kind: "stream";
      command: string[];
      cwd?: string;
      mode?: "line" | "match";
      match?: string;
      batchMs?: number;
      maxBatchBytes?: number;
    };

type CronSessionTarget = "main" | "isolated" | "current" | `session:${string}`;
type CronWakeMode = "next-heartbeat" | "now";

export type CronPayload = CoreCronPayload;

type CronCompletionDestination = {
  mode: "webhook";
  to: string;
};

type CronDelivery = {
  mode: "none" | "announce" | "webhook";
  channel?: string;
  to?: string;
  threadId?: string | number;
  accountId?: string;
  bestEffort?: boolean;
  completionDestination?: CronCompletionDestination;
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
  autoDisabled?: {
    reason: "consecutive-failures" | "schedule-errors";
    atMs: number;
    consecutiveErrors: number;
  };
  lastDelivered?: boolean;
  lastDeliveryStatus?: CronDeliveryStatus;
  lastDeliveryError?: string;
  lastFailureNotificationDelivered?: boolean;
  lastFailureNotificationDeliveryStatus?: CronDeliveryStatus;
  lastFailureNotificationDeliveryError?: string;
  lastFailureAlertAtMs?: number;
  streamStatus?: "starting" | "running" | "restarting" | "stopped" | "disabled" | "error";
  streamError?: string;
  streamConsecutiveFailures?: number;
  streamRestartExhausted?: boolean;
  streamSourceIdentity?: string;
  streamDroppedBatches?: number;
  streamCoalescedBatches?: number;
  streamLastStartedAtMs?: number;
  streamLastExitAtMs?: number;
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
  snapshotRevision: string;
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
  hasMore: boolean;
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
      ownerHandle?: string;
      requestedReference?: string;
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
    anyBins: string[];
    bins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  missing: {
    anyBins: string[];
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
  thinkingLevels?: GatewayThinkingLevelOption[];
  thinkingDefault?: string;
  supportsTools?: boolean;
  agentRuntime?: import("../../../packages/gateway-protocol/src/schema.js").GatewayAgentRuntime;
  input?: Array<"text" | "image" | "document">;
  apiKeySupported?: boolean;
};

export type ModelCatalogProviderOutcome =
  import("../../../packages/gateway-protocol/src/schema/agents-models-skills.js").ModelCatalogProviderOutcome;

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
export type SystemAgentSetupActivateParams =
  import("../../../packages/gateway-protocol/src/schema.js").SystemAgentSetupActivateParams;
export type SystemAgentSetupActivateResult =
  import("../../../packages/gateway-protocol/src/schema.js").SystemAgentSetupActivateResult;
export type SystemAgentSetupAuthStartResult =
  import("../../../packages/gateway-protocol/src/schema.js").SystemAgentSetupAuthStartResult;
export type SystemAgentSetupDetectResult =
  import("../../../packages/gateway-protocol/src/schema.js").SystemAgentSetupDetectResult;
export type SystemAgentSetupVerifyResult =
  import("../../../packages/gateway-protocol/src/schema.js").SystemAgentSetupVerifyResult;
export type WizardNextResult =
  import("../../../packages/gateway-protocol/src/schema.js").WizardNextResult;
export type WizardStep = import("../../../packages/gateway-protocol/src/schema.js").WizardStep;
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
