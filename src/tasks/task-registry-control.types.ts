// Defines task control runtime contracts exposed to command surfaces.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type * as taskControlRuntime from "./task-registry-control.runtime.js";

/** Admin cancellation hook for ACP sessions owned by task records. */
type CancelAcpSessionAdmin = (params: {
  cfg: OpenClawConfig;
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
  killSubagentRunAdmin: typeof taskControlRuntime.killSubagentRunAdmin;
};
