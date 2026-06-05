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
  heartbeat: import("../infra/heartbeat-summary.js").HeartbeatSummary;
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
};

/** Context engine quarantine entry included in health output. */
export type ContextEngineHealthQuarantineSummary = {
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

/** Optional model pricing cache health reported by the gateway. */
export type ModelPricingHealthSummary =
  import("../gateway/model-pricing-cache-state.js").GatewayModelPricingHealth;

/** Full gateway health payload consumed by `openclaw health`. */
export type HealthSummary = {
  ok: true;
  ts: number;
  durationMs: number;
  eventLoop?: import("../gateway/server/event-loop-health.js").GatewayEventLoopHealth;
  plugins?: PluginHealthSummary;
  contextEngines?: ContextEngineHealthSummary;
  modelPricing?: ModelPricingHealthSummary;
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
