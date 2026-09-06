import type { VerboseLevel } from "../auto-reply/thinking.js";
import type {
  AgentRunApprovalLeases,
  AgentRunApprovalClosureReason,
} from "./agent-run-approval-leases.js";
import type { AgentRunDelegatedAuthority } from "./agent-run-authority.types.js";

/** Per-run metadata used to stamp events and gate Control UI visibility. */
export type AgentRunContext = {
  sessionKey?: string;
  /** Resolved agent owner, including for unscoped session keys. */
  agentId?: string;
  /** Owning run's sessionId; stamped onto lifecycle events. */
  sessionId?: string;
  /** Gateway lifecycle generation captured when the run was registered. */
  lifecycleGeneration?: string;
  /** Producer-owned start captured from this run's accepted lifecycle event. */
  lifecycleStartedAt?: number;
  verboseLevel?: VerboseLevel;
  isHeartbeat?: boolean;
  /** Whether control UI clients should receive chat/agent updates for this run. */
  isControlUiVisible?: boolean;
  projectSessionActive?: boolean;
  /** Exact scheduler wait leases; absent during ordinary runtime preparation. */
  capacityWaits?: Set<symbol>;
  /** Whether hidden events may reach exact sessions.messages subscribers.
   * Internal maintenance sharing a foreground key disables this to prevent selected-chat leaks. */
  projectSessionMessages?: boolean;
  /** Whether lifecycle events may update the shared session row. */
  projectSessionLifecycle?: boolean;
  /** Sticky diagnostic provenance only; never authorization for recovery work. */
  mainSessionRestartRecovery?: true;
  /** Active cadence state by job; admission permits one invocation per job. */
  cronRunsByJobId?: Map<string, { pacingEnabled: boolean; nextCheckMs?: number }>;
  /** Timestamp when this context was first registered (for TTL-based cleanup). */
  registeredAt?: number;
  /** Timestamp of last activity (updated on every emitAgentEvent). */
  lastActiveAt?: number;
  /** Exact approval authority owned by this operational execution. */
  delegatedAuthority?: AgentRunDelegatedAuthority;
  /** Exact in-process source owner, intentionally absent from serialized authority. */
  assertSourceCurrent?: () => void;
  approvalLeases?: AgentRunApprovalLeases;
};

export type AgentRunContextOwnership = {
  lifecycleGeneration: string;
  claimIds: Set<string>;
  /** Live execution claims are lifecycle-owned and must not be expired by the projection sweeper. */
  sweepProtectedClaimIds: Set<string>;
  preserveAfterRelease: boolean;
  clearRequested: boolean;
  exclusiveClaimId?: string;
  clearListeners?: Map<string, (claimId: string) => void>;
};

export type AgentRunRegistryState = {
  contexts: Map<string, AgentRunContext>;
  owners: Map<string, AgentRunContextOwnership>;
  queuedRunContextLeases?: WeakMap<AgentRunContext, number>;
  lifecycleGeneration: string;
  sequenceResetHandler?: (runId: string) => void;
  delegatedAuthorityClosedHandlers?: Set<
    (authority: AgentRunDelegatedAuthority, approvalReason?: AgentRunApprovalClosureReason) => void
  >;
  version: number;
};

export type ProjectedAgentRunState = "queued" | "running" | "capacity-wait";

export type ProjectedAgentRunIndex = {
  sessionKeys: ReadonlyMap<string, ProjectedAgentRunState>;
  sessionIds: ReadonlyMap<string, ProjectedAgentRunState>;
  ownerlessSessionKeys: ReadonlyMap<string, ProjectedAgentRunState>;
  ownerlessSessionIds: ReadonlyMap<string, ProjectedAgentRunState>;
};
