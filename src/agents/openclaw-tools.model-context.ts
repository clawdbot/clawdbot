import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";

export type ModelAwareToolContext = {
  agentDir?: string;
  /** Lifecycle generation prepared for the active run. */
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  /** Auth profiles already loaded for prompt-time tool availability. */
  authProfileStore?: AuthProfileStore;
  /** Whether the active model accepts image content natively; this does not load arbitrary files. */
  modelHasVision?: boolean;
  /** Active provider/model pair used for tool gating. */
  modelProvider?: string;
  modelId?: string;
  /** Effective context ceiling for selected-model model-visible projections. */
  modelContextWindowTokens?: number;
  /** Explicit agent ID override for cron and hook sessions. */
  requesterAgentIdOverride?: string;
};
