import type { SubagentProgressOrigin } from "./subagent-registry.types.js";

type RegisterSubagentRunParams = {
  runId: string;
  childSessionKey: string;
  controllerSessionKey?: string;
  requesterSessionKey: string;
  requesterOrigin?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
    groupId?: string | null;
    groupChannel?: string | null;
    groupSpace?: string | null;
  };
  progressOrigin?: SubagentProgressOrigin;
  requesterDisplayKey: string;
  task: string;
  taskName?: string;
  agentId?: string;
  requesterAgentId?: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  agentDir?: string;
  workspaceDir?: string;
  runTimeoutSeconds?: number;
  expectsCompletionMessage?: boolean;
  spawnMode?: "run" | "session";
  silentAnnounce?: boolean;
  wakeOnReturn?: boolean;
  attachmentsDir?: string;
  attachmentsRootDir?: string;
  retainAttachmentsOnKeep?: boolean;
  continuationTargetSessionKey?: string;
  continuationTargetSessionKeys?: string[];
  continuationFanoutMode?: "tree" | "all";
  traceparent?: string;
};

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
