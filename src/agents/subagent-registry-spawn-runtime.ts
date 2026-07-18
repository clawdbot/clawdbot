import type { RegisterSubagentRunParams } from "./subagent-registry-run-manager.js";

type CountActiveRunsForSessionFn = (requesterSessionKey: string) => number;
type RegisterSubagentRunFn = (params: RegisterSubagentRunParams) => void;

let countActiveRunsForSessionImpl: CountActiveRunsForSessionFn | null = null;
let registerSubagentRunImpl: RegisterSubagentRunFn | null = null;

export function configureSubagentRegistrySpawnRuntime(params: {
  countActiveRunsForSession: CountActiveRunsForSessionFn;
  registerSubagentRun: RegisterSubagentRunFn;
}) {
  countActiveRunsForSessionImpl = params.countActiveRunsForSession;
  registerSubagentRunImpl = params.registerSubagentRun;
}

export function countActiveRunsForSession(requesterSessionKey: string): number {
  if (!countActiveRunsForSessionImpl) {
    console.warn(
      "[subagent-registry-spawn-runtime] countActiveRunsForSession called before configureSubagentRegistrySpawnRuntime()",
    );
    return 0;
  }
  return countActiveRunsForSessionImpl(requesterSessionKey);
}

export function registerSubagentRun(params: RegisterSubagentRunParams): void {
  if (!registerSubagentRunImpl) {
    console.warn(
      "[subagent-registry-spawn-runtime] registerSubagentRun called before configureSubagentRegistrySpawnRuntime()",
    );
    return;
  }
  registerSubagentRunImpl(params);
}
