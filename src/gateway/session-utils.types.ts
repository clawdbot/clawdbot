// Shared Gateway session projection types.
// Keeps server methods and Control UI payloads aligned.
import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import type {
  SessionPlacement,
  SessionPlacementMove,
  SessionRow,
} from "../../packages/gateway-protocol/src/index.js";
import type { QueueMode } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import type { StickyModelSelectionTarget } from "../agents/sticky-model-selection.js";
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
  GatewayContextWindowOption,
  GatewayThinkingLevelOption,
  SessionsListResultBase,
  SessionsPatchResultBase,
} from "../shared/session-types.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { PreparedGatewayModelCatalog } from "./server-model-catalog.types.js";

// Shared Gateway session response contracts. Server methods, UI adapters, and
// tests import these types so list/patch/preview payloads evolve together.
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
  modelSelectionTarget?: StickyModelSelectionTarget;
};

type SubagentRunState = "active" | "interrupted" | "historical";

type SessionCompactionCheckpointPreview = Pick<
  SessionCompactionCheckpoint,
  "checkpointId" | "createdAt" | "reason"
>;

export type GatewaySessionRow = Omit<SessionRow, "archivedBy" | "updatedAt" | "worktree"> & {
  worktree?: SessionEntry["worktree"];
  category?: string;
  subject?: string;
  groupChannel?: string;
  space?: string;
  origin?: Omit<SessionOrigin, "avatar">;
  updatedAt: number | null;
  archivedBy?: SessionEntry["archivedBy"];
  agentStatus?: SessionEntry["agentStatus"];
  observerDigest?: Pick<
    SessionObserverDigest,
    "agentId" | "runId" | "headline" | "health" | "updatedAt" | "revision"
  >;
  placement?: SessionPlacement;
  placementMove?: SessionPlacementMove;
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
  traceLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  sendPolicy?: "allow" | "deny";
  goal?: SessionGoal;
  hasActiveRun?: boolean;
  activeRunIds?: string[];
  hasAutomation?: boolean;
  subagentRunState?: SubagentRunState;
  hasActiveSubagentRun?: boolean;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  responseUsage?: "on" | "off" | "tokens" | "full";
  effectiveResponseUsage?: "on" | "off" | "tokens" | "full";
  queueMode?: QueueMode;
  effectiveQueueMode?: QueueMode;
  modelSelectionLocked?: boolean;
  agentRuntime?: GatewayAgentRuntime;
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

/**
 * Per-agent completed model catalogs for a session listing. Scoped listings
 * carry exactly one agent's catalog; unscoped listings carry one per configured
 * agent so row projections stay owner-scoped.
 */
export type SessionListModelCatalog = ReadonlyMap<string, PreparedGatewayModelCatalog | undefined>;

export type SessionsPatchResult = SessionsPatchResultBase<SessionEntry> & {
  entry: SessionEntry;
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
