import type { CompactEmbeddedPiSessionParams } from "../pi-embedded-runner/compact.types.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../pi-embedded-runner/run/types.js";
import type { EmbeddedAgentRuntime } from "../pi-embedded-runner/runtime.js";
import type { EmbeddedPiCompactResult } from "../pi-embedded-runner/types.js";

export type AgentHarnessSupportContext = {
  provider: string;
  modelId?: string;
  requestedRuntime: EmbeddedAgentRuntime;
};

export type AgentHarnessSupport =
  | { supported: true; priority?: number; reason?: string }
  | { supported: false; reason?: string };

export type AgentHarnessAttemptParams = EmbeddedRunAttemptParams;
export type AgentHarnessAttemptResult = EmbeddedRunAttemptResult;
export type AgentHarnessCompactParams = CompactEmbeddedPiSessionParams;
export type AgentHarnessCompactResult = EmbeddedPiCompactResult;
export type AgentHarnessResetParams = {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
  reason?: "new" | "reset" | "idle" | "daily" | "compaction" | "deleted" | "unknown";
};

export type AgentHarness = {
  id: string;
  label: string;
  pluginId?: string;
  supports(ctx: AgentHarnessSupportContext): AgentHarnessSupport;
  runAttempt(params: AgentHarnessAttemptParams): Promise<AgentHarnessAttemptResult>;
  compact?(params: AgentHarnessCompactParams): Promise<AgentHarnessCompactResult | undefined>;
  reset?(params: AgentHarnessResetParams): Promise<void> | void;
  dispose?(): Promise<void> | void;
};

export type RegisteredAgentHarness = {
  harness: AgentHarness;
  ownerPluginId?: string;
};
