// Task state imports this leaf; importing runtime barrels here closes a type dependency cycle.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DetachedTaskTerminalState } from "./detached-task-runtime-contract.js";

export type SubagentKillTargetState =
  | { state: "finalizing" }
  | { state: "terminal"; task: DetachedTaskTerminalState };

export type SubagentAdminKillResult =
  | { found: false; killed: false }
  | {
      found: true;
      killed: boolean;
      runId: string;
      sessionKey: string;
      cascadeKilled: number;
      cascadeLabels?: string[];
      targetState?: SubagentKillTargetState;
      error?: string;
    };

/** Admin cancellation hook for ACP sessions owned by task records. */
type CancelAcpSessionAdmin = (params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  reason: string;
  expectedRunId?: string;
  expectedInstanceId?: string;
  expectedOwnerKey?: string;
}) => Promise<void>;

export type TaskRegistryControlRuntime = {
  cancelBackgroundExecSession?: (sessionId: string) => boolean;
  cancelActiveCronTaskRun: (params: { runId: string | undefined; reason?: string }) => boolean;
  getAcpSessionManager: () => {
    cancelSession: CancelAcpSessionAdmin;
  };
  killSubagentRunAdmin: (params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId?: string;
    expectedRunId?: string;
    /** Stable task identity; resolves once to the current execution before cancellation. */
    expectedTaskRunId?: string;
    expectedGeneration?: number;
    expectedOwnerKey?: string;
    /** Consume the result synchronously while its exact run ownership is still held. */
    onResult?: (result: SubagentAdminKillResult) => undefined;
  }) => Promise<SubagentAdminKillResult>;
};
