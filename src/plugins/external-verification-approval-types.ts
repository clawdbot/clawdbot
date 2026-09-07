import type {
  ApprovalAllowDecision,
  ApprovalSnapshot,
} from "../../packages/gateway-protocol/src/index.js";
import type { PluginStateEntry } from "../plugin-state/plugin-state-store.types.js";

/** Plugin-owned reviewer choices that require an external verification ceremony. */
export type PluginExternalResolution = {
  label: string;
  decisions?: readonly ApprovalAllowDecision[];
};

/** Host-derived approval context that verifier challenges must bind. */
export type PluginExternalVerificationContext = Readonly<{
  approvalId: string;
  pluginId: string;
  runId: string;
  toolName: string;
  toolCallId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  decision: ApprovalAllowDecision;
  label: string;
  expiresAtMs: number;
}>;

/** Immutable context for one host-authenticated external verification attempt. */
export type PluginExternalVerificationAttempt = Readonly<{
  id: string;
  context: PluginExternalVerificationContext;
  createdAtMs: number;
  signal: AbortSignal;
  present: (params: { message: string }) => Promise<void>;
}>;

/** Persisted, proof-free attempt projection returned by completion calls. */
export type PluginExternalVerificationAttemptSnapshot = Omit<
  PluginExternalVerificationAttempt,
  "present" | "signal"
> & {
  endedAtMs?: number;
  outcome?: "succeeded" | "failed" | "cancelled" | "timed-out";
  errorClass?: string;
  terminalSource?: string;
};

/** Stable host authorization emitted only when external verification wins the approval race. */
export type PluginExternalVerificationGrantAuthorization = {
  id: string;
  issuedAtMs: number;
  approvalId: string;
  attemptId: string;
  decision: ApprovalAllowDecision;
};

/** Idempotent completion result derived entirely from host-owned attempt state. */
export type PluginExternalVerificationCompletionResult = {
  applied: boolean;
  approval: ApprovalSnapshot;
  attempt: PluginExternalVerificationAttemptSnapshot;
  grantAuthorization?: PluginExternalVerificationGrantAuthorization;
};

export type PluginExternalVerificationHandler = (
  attempt: PluginExternalVerificationAttempt,
) => Promise<void> | void;

/** Durable grant storage that preserves prior authorizations and tombstones. */
export type PluginExternalVerificationGrantStore<T> = {
  registerIfAbsent: (key: string, value: T) => boolean;
  lookup: (key: string) => T | undefined;
  entries: () => PluginStateEntry<T>[];
  update: (key: string, updateValue: (current: T | undefined) => T | undefined) => boolean;
};

export type OpenClawPluginApprovalsApi = {
  /** Register this plugin's single verifier for host-authenticated approval attempts. */
  onExternalVerification: (handler: PluginExternalVerificationHandler) => void;
  /** Complete an attempt owned by this plugin; plugin and approval identity are host-derived. */
  completeExternalVerification: (params: {
    attemptId: string;
    outcome: "succeeded" | "failed";
  }) => Promise<PluginExternalVerificationCompletionResult>;
  /** Open bounded plugin-owned storage for stable grant authorizations and tombstones. */
  openGrantStore: <T>() => PluginExternalVerificationGrantStore<T>;
};
