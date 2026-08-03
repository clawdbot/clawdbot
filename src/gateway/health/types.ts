// Shared summary types returned by gateway health and rendered by the CLI.
/** Health snapshot for one configured channel account. */
export type ChannelAccountHealthSummary = {
  accountId: string;
  configured?: boolean;
  linked?: boolean;
  authAgeMs?: number | null;
  probe?: unknown;
  lastProbeAt?: number | null;
  [key: string]: unknown;
};

/** Channel-level health summary with optional per-account details. */
export type ChannelHealthSummary = ChannelAccountHealthSummary & {
  accounts?: Record<string, ChannelAccountHealthSummary>;
};

/** Agent heartbeat and session-store health metadata. */
export type AgentHealthSummary = {
  agentId: string;
  name?: string;
  isDefault: boolean;
  heartbeat: import("../../infra/heartbeat-summary.js").HeartbeatSummary;
  sessions: HealthSummary["sessions"];
};

/** Plugin load error details safe for the health payload. */
export type PluginHealthErrorSummary = {
  id: string;
  origin: string;
  activated: boolean;
  activationSource?: string;
  activationReason?: string;
  failurePhase?: string;
  error: string;
};

/** Plugin registry health summary. */
export type PluginHealthSummary = {
  loaded: string[];
  errors: PluginHealthErrorSummary[];
  unavailable?: Array<{
    id: string;
    state: "configured-unavailable";
    diagnostic: {
      kind: "plugin-verification";
      reason: import("../../plugins/runtime-degraded-state.js").PluginVerificationFailureReason;
      detail: string;
    };
  }>;
};

/** Context engine quarantine entry included in health output. */
type ContextEngineHealthQuarantineSummary = {
  engineId: string;
  owner?: string;
  operation: string;
  reason: string;
  failedAt: number;
};

/** Context engine health summary. */
export type ContextEngineHealthSummary = {
  quarantined: ContextEngineHealthQuarantineSummary[];
};

/** Dead-lettered delivery queue entries surfaced in health output. */
export type DeliveryQueueHealthSummary = {
  failed: Array<{
    queueName: string;
    count: number;
    oldestFailedAt?: number;
  }>;
  ingressFailed?: Array<{
    channelId: string;
    accountId: string;
    count: number;
    oldestFailedAt?: number;
  }>;
};

/** Live process-local health for ephemeral per-session command lanes. */
export type SessionLaneHealthSummary = {
  status: "healthy" | "degraded" | "unhealthy";
  count: number;
  activeCount: number;
  queuedCount: number;
  idleCount: number;
  oldestAgeMs: number | null;
  oldestQueuedAgeMs: number | null;
};

/** Config hot-reload watcher status, present only when a reloader is running. */
type ConfigReloadHealthSummary = {
  hotReloadStatus: import("../config-reload-status.types.js").GatewayHotReloadStatus;
};

/** Full gateway health payload consumed by `openclaw health`. */
export type HealthSummary = {
  ok: true;
  ts: number;
  durationMs: number;
  eventLoop?: import("../server/event-loop-health.js").GatewayEventLoopHealth;
  /** Always present on newly collected snapshots; optional for persisted/test legacy snapshots. */
  sessionLanes?: SessionLaneHealthSummary;
  plugins?: PluginHealthSummary;
  contextEngines?: ContextEngineHealthSummary;
  deliveryQueues?: DeliveryQueueHealthSummary;
  configReload?: ConfigReloadHealthSummary;
  channels: Record<string, ChannelHealthSummary>;
  channelOrder: string[];
  channelLabels: Record<string, string>;
  heartbeatSeconds: number;
  defaultAgentId: string;
  agents: AgentHealthSummary[];
  sessions: {
    path: string;
    count: number;
    recent: Array<{
      key: string;
      updatedAt: number | null;
      age: number | null;
    }>;
  };
};
