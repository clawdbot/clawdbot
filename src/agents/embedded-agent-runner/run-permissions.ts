import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import {
  getAgentRunContext,
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { ACTIVE_EMBEDDED_RUNS } from "./run-state.js";
import { withAuthorizedPermissionChange } from "./run/permission-change.js";
import { resolveEmbeddedAgentRunProgressState } from "./runs.js";

/** Captures one exact live runtime; a later run must never inherit this update. */
export function prepareEmbeddedRunPermissionChange(sessionId: string) {
  if (!resolveEmbeddedAgentRunProgressState(sessionId)) {
    return { kind: "idle" as const };
  }
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle?.applyPermissionMode) {
    return { kind: "unsupported" as const };
  }
  const applyPermissionMode = handle.applyPermissionMode;
  const generation = getAgentEventLifecycleGeneration();
  const owner = handle.permissionChangeOwner;
  const authority = handle.runId ? getAgentRunContext(handle.runId)?.delegatedAuthority : undefined;
  const ownsRuntime = () => {
    const current = ACTIVE_EMBEDDED_RUNS.get(sessionId);
    return (
      isAgentEventLifecycleGenerationCurrent(generation) &&
      (current === handle || (owner !== undefined && current?.permissionChangeOwner === owner))
    );
  };
  return {
    kind: "active" as const,
    stop: () => {
      if (ownsRuntime()) {
        ACTIVE_EMBEDDED_RUNS.get(sessionId)?.abort();
      }
    },
    apply: async (
      mode: Parameters<typeof applyPermissionMode>[0],
      revokeApprovals: (authority: AgentRunDelegatedAuthority) => void,
    ): Promise<boolean> => {
      if (!ownsRuntime()) {
        return false;
      }
      const revoke = () => {
        if (!ownsRuntime() || (authority && !validateAgentRunDelegatedAuthority(authority))) {
          throw new Error("Permission change lost its active run. Retry the request.");
        }
        if (authority) {
          revokeApprovals(authority);
        }
      };
      const apply = () => applyPermissionMode(mode, revoke);
      const application = owner ? withAuthorizedPermissionChange(owner, mode, apply) : apply();
      const applied = await application;
      return (
        applied &&
        isAgentEventLifecycleGenerationCurrent(generation) &&
        (!ACTIVE_EMBEDDED_RUNS.has(sessionId) || ownsRuntime())
      );
    },
  };
}
