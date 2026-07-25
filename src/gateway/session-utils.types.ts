// Shared Gateway session projection types.
// Keeps server methods and Control UI payloads aligned.
import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import type {
  SessionCreatedActor,
  SessionPlacement,
  SessionRow,
  SessionSharingRole,
  SessionVisibility,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import type { QueueMode } from "../auto-reply/reply/queue/types.js";
import type { ChatType } from "../channels/chat-type.js";
import type {
  SessionCompactionCheckpoint,
  SessionEntry,
  SessionGoal,
  SessionOrigin,
} from "../config/sessions/types.js";
import type { PluginSessionExtensionProjection } from "../plugins/host-hooks.js";
import type { FastModeSource } from "../shared/fast-mode.js";
import type {
  GatewayAgentRuntime,
  GatewayAgentRow as SharedGatewayAgentRow,
  GatewayThinkingLevelOption,
  SessionsListResultBase,
  SessionsPatchResultBase,
} from "../shared/session-types.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

// Shared Gateway session response contracts. Server methods, UI adapters, and
// tests import these types so list/patch/preview payloads evolve together.
export type GatewaySessionsDefaults = {
  modelProvider: string | null;
  model: string | null;
  contextTokens: number | null;
  agentRuntime?: GatewayAgentRuntime;
  thinkingLevels?: GatewayThinkingLevelOption[];
  thinkingOptions?: string[];
  thinkingDefault?: string;
};

/** Runtime status surfaced for the latest session run. */
export type SessionRunStatus = "running" | "done" | "failed" | "killed" | "timeout";

type SubagentRunState = "active" | "interrupted" | "historical";

type SessionCompactionCheckpointPreview = Pick<
  SessionCompactionCheckpoint,
  "checkpointId" | "createdAt" | "reason"
>;

export type GatewaySessionRow = {
  key: string;
  /** Additive collaboration state; absent on older gateways. */
  visibility?: SessionVisibility;
  /** Caller-relative role used by Control UI participation controls. */
  sharingRole?: SessionSharingRole;
  incognito?: true;
  spawnedBy?: string;
  /** Current runtime controller, falling back to the durable spawning session. */
  controlOwnerSessionKey?: string;
  /** Collector swarm group that owns this child session, when applicable. */
  swarmGroupId?: string;
  spawnedWorkspaceDir?: string;
  spawnedCwd?: string;
  /** Managed worktree bound to this session (repo checkout + branch). */
  worktree?: SessionEntry["worktree"];
  /** Session-scoped exec node binding (exec host=node routing). */
  execNode?: string;
  /** Working directory interpreted only by the bound exec node. */
  execCwd?: string;
  forkedFromParent?: boolean;
  spawnDepth?: number;
  subagentRole?: SessionEntry["subagentRole"];
  subagentControlScope?: SessionEntry["subagentControlScope"];
  createdVia?: SessionEntry["createdVia"];
  createdActor?: SessionCreatedActor;
  createdAt?: SessionEntry["createdAt"];
  forkSource?: SessionEntry["forkSource"];
  previousSessionId?: SessionEntry["previousSessionId"];
  kind: "direct" | "group" | "global" | "unknown";
  label?: string;
  /** User-defined organization bucket; unrelated to chat-group kind/groupChannel. */
  category?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  channel?: string;
  subject?: string;
  groupChannel?: string;
  space?: string;
  chatType?: ChatType;
  origin?: SessionOrigin;
  updatedAt: number | null;
  archived?: boolean;
  archivedAt?: number;
  archivedBy?: SessionEntry["archivedBy"];
  pinned?: boolean;
  pinnedAt?: number;
  icon?: string;
  unread?: boolean;
  lastReadAt?: number;
  agentStatus?: SessionEntry["agentStatus"];
  observerDigest?: Pick<
    SessionObserverDigest,
    "runId" | "headline" | "health" | "updatedAt" | "revision"
  >;
  /** Last real user/channel interaction; background work does not advance it. */
  lastInteractionAt?: number;
  lastActivityAt?: number;
  sessionId?: string;
  placement?: SessionPlacement;
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
  traceLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  sendPolicy?: "allow" | "deny";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  goal?: SessionGoal;
  estimatedCostUsd?: number;
  status?: SessionRunStatus;
  /** Compact user-facing reason for the latest failed or timed-out run. */
  lastRunError?: string;
  hasActiveRun?: boolean;
  activeRunIds?: string[];
  /** Active transcript-branch leaf for history rendered from this row. */
  activeLeafEntryId?: string | null;
  /** An enabled cron job is bound to this session (runs in it or delivers to it). */
  hasAutomation?: boolean;
  subagentRunState?: SubagentRunState;
  hasActiveSubagentRun?: boolean;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  parentSessionKey?: string;
  childSessions?: string[];
  responseUsage?: "on" | "off" | "tokens" | "full";
  /** Resolved effective usage mode (session override → channel config → default → off). Populated by surfaces that have config access; absent from the raw session store row. */
  effectiveResponseUsage?: "on" | "off" | "tokens" | "full";
  /** Explicit per-session queue override, before channel/global defaults. */
  queueMode?: QueueMode;
  /** Queue mode for Control UI sends (session override → webchat config → global default). */
  effectiveQueueMode?: QueueMode;
  modelProvider?: string;
  model?: string;
  modelSelectionLocked?: boolean;
  agentRuntime?: GatewayAgentRuntime;
  contextTokens?: number;
  contextBudgetStatus?: SessionEntry["contextBudgetStatus"];
  deliveryContext?: DeliveryContext;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  compactionCheckpointCount?: number;
  latestCompactionCheckpoint?: SessionCompactionCheckpointPreview;
  pluginExtensions?: PluginSessionExtensionProjection[];
};

/**
 * Compile-time drift guard: fails typecheck when the Gateway projection stops
 * matching the protocol schema's documented row fields. Value-level so the
 * unused-export scan sees a consumer.
 */
const sessionRowSchemaDriftGuard: Pick<GatewaySessionRow, keyof SessionRow> extends SessionRow
  ? true
  : false = true;
void sessionRowSchemaDriftGuard;

export type GatewayAgentRow = SharedGatewayAgentRow;

export type SessionPreviewItem = {
  role: "user" | "assistant" | "tool" | "system" | "other";
  text: string;
};

export type SessionsPreviewEntry = {
  key: string;
  status: "ok" | "empty" | "missing" | "error";
  items: SessionPreviewItem[];
};

export type SessionsPreviewResult = {
  ts: number;
  previews: SessionsPreviewEntry[];
};

export type SessionsListResult = SessionsListResultBase<GatewaySessionsDefaults, GatewaySessionRow>;

export type SessionsPatchResult = SessionsPatchResultBase<SessionEntry> & {
  entry: SessionEntry;
  resolved?: {
    modelProvider?: string;
    model?: string;
    agentRuntime?: GatewayAgentRuntime;
    thinkingLevel?: string;
    thinkingLevels?: GatewayThinkingLevelOption[];
  };
};
