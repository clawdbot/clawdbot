/** Shared node-host request, result, event, and approval-bin provider contracts. */
import type { SkillBinTrustEntry, SystemRunApprovalPlan } from "../infra/exec-approvals.js";

/**
 * Shared request/result/event types for node-host command execution.
 *
 * These contracts are consumed by Gateway invoke handling, approval planning,
 * and node-host event emission.
 */
/** Gateway invoke frame delivered to node-host command handlers. */
export type NodeInvokeRequestPayload = {
  id: string;
  nodeId: string;
  command: string;
  paramsJSON?: string | null;
  timeoutMs?: number | null;
  idempotencyKey?: string | null;
  sessionKey?: string | null;
};

/** Input payload for a node-host system.run invocation. */
export type SystemRunParams = {
  command: string[];
  rawCommand?: string | null;
  systemRunPlan?: SystemRunApprovalPlan | null;
  cwd?: string | null;
  env?: Record<string, string>;
  timeoutMs?: number | null;
  needsScreenRecording?: boolean | null;
  agentId?: string | null;
  sessionKey?: string | null;
  approved?: boolean | null;
  approvalDecision?: string | null;
  approvalSource?: string | null;
  runId?: string | null;
  suppressNotifyOnExit?: boolean | null;
};

/** Captured process result returned by system.run execution. */
export type RunResult = {
  exitCode?: number;
  timedOut: boolean;
  noOutputTimedOut?: boolean;
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string | null;
  truncated: boolean;
};

/** Gateway event payload emitted for exec lifecycle notifications. */
export type ExecEventPayload = {
  sessionKey: string;
  runId: string;
  host: string;
  command?: string;
  exitCode?: number;
  timedOut?: boolean;
  success?: boolean;
  output?: string;
  reason?: string;
  suppressNotifyOnExit?: boolean;
};

/** Normalized exec result fields used when building finished events. */
export type ExecFinishedResult = {
  stdout?: string;
  stderr?: string;
  error?: string | null;
  exitCode?: number | null;
  timedOut?: boolean;
  success?: boolean;
};

/** Inputs required to emit an exec finished event. */
export type ExecFinishedEventParams = {
  sessionKey: string;
  runId: string;
  commandText: string;
  result: ExecFinishedResult;
  suppressNotifyOnExit?: boolean;
};

/** Provider for trusted skill-bin entries used during approval checks. */
export type SkillBinsProvider = {
  current(force?: boolean): Promise<SkillBinTrustEntry[]>;
};
