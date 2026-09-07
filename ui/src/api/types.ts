import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import type {
  ArtifactSummary as ProtocolArtifactSummary,
  CronJob as ProtocolCronJob,
  CronListParams,
  CronRunLogEntry as ProtocolCronRunLogEntry,
  CronRunsParams,
  SessionsFilesListResult as ProtocolSessionsFilesListResult,
} from "../../../packages/gateway-protocol/src/index.js";
import type {
  AgentsListResult as ProtocolAgentsListResult,
  ModelChoice as ProtocolModelChoice,
} from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { ChannelsStatusResult } from "../../../packages/gateway-protocol/src/schema/channels.js";
import type { QueueMode } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type {
  SessionEntryArchiveReason,
  SessionRow,
} from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
import type {
  SessionCompactionCheckpoint as ProtocolSessionCompactionCheckpoint,
  SessionObserverDigest,
  SessionsCompactionBranchResult as ProtocolSessionsCompactionBranchResult,
  SessionsCompactionListResult as ProtocolSessionsCompactionListResult,
  SessionsCompactionRestoreResult as ProtocolSessionsCompactionRestoreResult,
} from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { PresenceEntry as ProtocolPresenceEntry } from "../../../packages/gateway-protocol/src/schema/snapshot.js";
import type { SessionAgentStatus } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import type {
  SessionContextBudgetStatus,
  SessionGoal,
} from "../../../src/config/sessions/types.js";
import type { FastModeSource } from "../../../src/shared/fast-mode.js";
import type {
  GatewayAgentRuntime,
  GatewayAgentRow as SharedGatewayAgentRow,
  GatewayContextWindowOption,
  GatewayThinkingLevelOption,
  SessionsListResultBase,
  SessionsPatchResultBase,
} from "../../../src/shared/session-types.js";
export type {
  AgentIdentityResult,
  ArtifactsDownloadResult as ArtifactDownloadResult,
  ConfigSchemaResponse,
  ModelsListResult as ModelCatalogResult,
  AgentsFileEntry as AgentFileEntry,
  AgentsFilesListResult,
  AgentsFilesGetResult,
  AgentsFilesSetResult,
  SessionsFilesGetResult as SessionWorkspaceGetResult,
  SessionsFilesSetResult as SessionWorkspaceSetResult,
  CronJob,
  CronRunLogEntry,
  CronScratchGetResult,
  UpdateAvailable,
  UpdateHoldResult,
  UpdateReportResult,
  UpdateScheduleState,
} from "../../../packages/gateway-protocol/src/index.js";
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
export type SessionMembersListEvidenceResult =
  import("../../../packages/gateway-protocol/src/index.js").SessionMembersListEvidenceResult;
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

type ChannelProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs?: number | null;
};

type ChannelStatus<Probe = ChannelProbe> = {
  configured: boolean;
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: Probe | null;
  lastProbeAt?: number | null;
};

type TelegramProbe = ChannelProbe & {
  bot?: { id?: number | null; username?: string | null } | null;
  webhook?: { url?: string | null; hasCustomCert?: boolean | null } | null;
};

export type TelegramStatus = ChannelStatus<TelegramProbe> & {
  tokenSource?: string | null;
  mode?: string | null;
};

type DiscordProbe = ChannelProbe & {
  bot?: { id?: string | null; username?: string | null } | null;
};

export type DiscordStatus = ChannelStatus<DiscordProbe> & {
  tokenSource?: string | null;
};

export type GoogleChatStatus = ChannelStatus & {
  credentialSource?: string | null;
  audienceType?: string | null;
  audience?: string | null;
  webhookPath?: string | null;
  webhookUrl?: string | null;
};

type SlackIdentity = {
  id?: string | null;
  name?: string | null;
};

type SlackProbe = ChannelProbe & {
  bot?: SlackIdentity | null;
  team?: SlackIdentity | null;
};

export type SlackStatus = ChannelStatus<SlackProbe> & {
  botTokenSource?: string | null;
  appTokenSource?: string | null;
};

export type SignalStatus = ChannelStatus<ChannelProbe & { version?: string | null }> & {
  baseUrl: string;
};

export type IMessageStatus = ChannelStatus<Pick<ChannelProbe, "ok" | "error">> & {
  cliPath?: string | null;
  dbPath?: string | null;
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

export type PresenceEntry = ProtocolPresenceEntry;

export type GatewaySessionsDefaults = {
  modelProvider: string | null;
  model: string | null;
  contextTokens: number | null;
  contextWindow?: string;
  contextWindows?: GatewayContextWindowOption[];
  contextWindowDefault?: string;
  agentRuntime?: GatewayAgentRuntime;
  thinkingLevels?: GatewayThinkingLevelOption[];
  thinkingOptions?: string[];
  thinkingDefault?: string;
  modelSelectionTarget?: "session" | "agent" | "global";
};

export type GatewayAgentRow = SharedGatewayAgentRow;
export type { GatewayContextWindowOption, GatewayThinkingLevelOption };

export type AgentsListResult = ProtocolAgentsListResult;

type SessionWorkspaceArtifactEntry = ProtocolArtifactSummary;

// The workspace view joins file results with separately fetched artifacts.
export type SessionWorkspaceListResult = ProtocolSessionsFilesListResult & {
  artifacts?: SessionWorkspaceArtifactEntry[];
};

type SubagentRunState = "active" | "interrupted" | "historical";

export type SessionCompactionCheckpoint = Omit<
  ProtocolSessionCompactionCheckpoint,
  "tokensVersion"
>;

type SessionCompactionCheckpointPreview = Pick<
  SessionCompactionCheckpoint,
  "checkpointId" | "createdAt" | "reason"
>;

export type GatewaySessionRow = SessionRow & {
  contextBudgetStatus?: SessionContextBudgetStatus;
  /** Transient UI-owned Swarm note overlays, not persisted session fields. */
  swarmPhase?: string;
  swarmPhaseRank?: number;
  swarmLog?: string;
  placement?: import("../../../packages/gateway-protocol/src/index.js").SessionPlacement;
  placementMove?: import("../../../packages/gateway-protocol/src/index.js").SessionPlacementMove;
  icon?: string;
  channelAvatarUrl?: string;
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
  contextWindow?: string;
  contextWindows?: GatewayContextWindowOption[];
  contextWindowDefault?: string;
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

export type SessionsCompactionListResult = Omit<
  ProtocolSessionsCompactionListResult,
  "checkpoints"
> & {
  checkpoints: SessionCompactionCheckpoint[];
};

type SessionCompactionMutationResult<T> = Omit<T, "checkpoint" | "entry"> & {
  checkpoint: SessionCompactionCheckpoint;
  entry: {
    sessionId: string;
    updatedAt: number;
  } & Record<string, unknown>;
};

export type SessionsCompactionBranchResult =
  SessionCompactionMutationResult<ProtocolSessionsCompactionBranchResult>;

export type SessionsCompactionRestoreResult =
  SessionCompactionMutationResult<ProtocolSessionsCompactionRestoreResult>;

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
  permissionMode?: GatewaySessionRow["permissionMode"];
  archivedAt?: number;
  archiveReason?: SessionEntryArchiveReason;
  /** Present only while an explicit mark-unread marker owns the row. */
  markedUnreadAt?: number;
  contextWindow?: string;
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
    contextWindow?: string;
    contextWindows?: GatewayContextWindowOption[];
    thinkingLevel?: string;
    thinkingLevels?: GatewayThinkingLevelOption[];
  };
};

export type { CostUsageSummary, SessionsUsageResult } from "../pages/usage/data-types.ts";

export type CronRunStatus = NonNullable<ProtocolCronRunLogEntry["status"]>;
export type CronDeliveryStatus = NonNullable<ProtocolCronRunLogEntry["deliveryStatus"]>;
export type CronJobsEnabledFilter = NonNullable<CronListParams["enabled"]>;
export type CronJobsScheduleKindFilter = NonNullable<CronListParams["scheduleKind"]>;
export type CronJobsTriggerFilter = NonNullable<CronListParams["trigger"]>;
export type CronJobsSortBy = NonNullable<CronListParams["sortBy"]>;
export type CronRunScope = NonNullable<CronRunsParams["scope"]>;
export type CronRunsStatusValue = NonNullable<CronRunsParams["statuses"]>[number];
export type CronRunsStatusFilter = NonNullable<CronRunsParams["status"]>;
export type CronSortDir = NonNullable<CronListParams["sortDir"]>;
export type CronPayload = ProtocolCronJob["payload"];

export type CronStatus = {
  enabled: boolean;
  triggersEnabled: boolean;
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

export type CronJobsListResult = {
  jobs: ProtocolCronJob[];
  snapshotRevision: string;
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
  hasMore: boolean;
};

export type CronRunsResult = {
  entries: ProtocolCronRunLogEntry[];
  total?: number;
  limit?: number;
  offset?: number;
  nextOffset?: number | null;
  hasMore?: boolean;
};

export type {
  SkillStatusEntry,
  SkillStatusReport,
} from "../../../src/skills/discovery/status.types.js";
export type { ClawHubSkillStatusLink as SkillClawHubLink } from "../../../src/skills/lifecycle/clawhub-status.js";

export type StatusSummary = Record<string, unknown>;

export type HealthSnapshot = Record<string, unknown>;

/** A model entry returned by the gateway model-catalog endpoint. */
export type ModelCatalogEntry = ProtocolModelChoice;

export type ModelCatalogProviderOutcome =
  import("../../../packages/gateway-protocol/src/schema/agents-models-skills.js").ModelCatalogProviderOutcome;

export type ToolCatalogProfile =
  import("../../../packages/gateway-protocol/src/schema.js").ToolCatalogProfile;
export type ToolsCatalogResult =
  import("../../../packages/gateway-protocol/src/schema.js").ToolsCatalogResult;
export type ToolsGitHubStatusResult =
  import("../../../packages/gateway-protocol/src/schema.js").ToolsGitHubStatusResult;
export type ToolsGitHubAuthorizeStartResult =
  import("../../../packages/gateway-protocol/src/schema.js").ToolsGitHubAuthorizeStartResult;
export type ToolsGitHubAuthorizePollResult =
  import("../../../packages/gateway-protocol/src/schema.js").ToolsGitHubAuthorizePollResult;
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
export type SystemAgentSetupDetectResult =
  import("../../../packages/gateway-protocol/src/schema.js").SystemAgentSetupDetectResult;
export type SystemAgentSetupVerifyResult =
  import("../../../packages/gateway-protocol/src/schema.js").SystemAgentSetupVerifyResult;
export type WizardNextResult =
  import("../../../packages/gateway-protocol/src/schema.js").WizardNextResult;
export type WizardStep = import("../../../packages/gateway-protocol/src/schema.js").WizardStep;
