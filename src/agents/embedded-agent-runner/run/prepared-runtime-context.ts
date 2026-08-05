import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.js";
import type { ResolveRunWorkspaceResult } from "../../workspace-run.js";
import type { RunEmbeddedAgentParamsWithSessionFile } from "./internal-params.js";

/** Rebinds every config-derived run projection to one committed prepared generation. */
export function bindRunToPreparedModelRuntime(params: {
  runParams: RunEmbeddedAgentParamsWithSessionFile;
  requestedWorkspaceResolution: ResolveRunWorkspaceResult;
  preparedModelRuntime: PreparedModelRuntimeSnapshot;
}): {
  runParams: RunEmbeddedAgentParamsWithSessionFile;
  workspaceResolution: ResolveRunWorkspaceResult;
} {
  const preparedAgentId =
    params.preparedModelRuntime.agentId ?? params.requestedWorkspaceResolution.agentId;
  const workspaceResolution = {
    ...params.requestedWorkspaceResolution,
    agentId: preparedAgentId,
    workspaceDir:
      params.preparedModelRuntime.workspaceDir ?? params.requestedWorkspaceResolution.workspaceDir,
  };
  return {
    runParams: {
      ...params.runParams,
      agentId: preparedAgentId,
      agentDir: params.preparedModelRuntime.agentDir,
      config: params.preparedModelRuntime.config,
      workspaceDir: workspaceResolution.workspaceDir,
    },
    workspaceResolution,
  };
}
