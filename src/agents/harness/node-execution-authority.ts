import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { capturePluginLifecycleAuthority } from "../../plugins/registry-lifecycle.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import {
  getGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";

type HostAttempt = Partial<EmbeddedRunAttemptParams> &
  Pick<EmbeddedRunAttemptParams, "admittedRunContext" | "runId">;
type SessionNodeInvocation = NonNullable<
  NonNullable<
    ReturnType<typeof getPluginRuntimeGatewayRequestScope>
  >["invokeWithSessionNodeAuthority"]
>;
type SessionNodeRequest = Parameters<SessionNodeInvocation>[0];
type SessionNodeGrantAuthority = NonNullable<
  NonNullable<ReturnType<typeof getPluginRuntimeGatewayRequestScope>>["nodePlacementGrantAuthority"]
>;
type SessionNodeAuthorities = {
  invokeWithSessionNodeAuthority?: SessionNodeInvocation;
  nodePlacementGrantAuthority?: SessionNodeGrantAuthority;
};

/** Full is admitted host authority, narrowed to one placement claim, never a request flag. */
export function createSessionNodeAuthorities(
  attempt: HostAttempt,
  pluginId: string,
  requiredNodeCommands: ReadonlySet<string>,
  assertActive: () => void,
  signal: AbortSignal,
): SessionNodeAuthorities {
  const admittedFull = attempt.permissionMode === "full";
  const resolveContext = getGatewayContextResolver(attempt.admittedRunContext);
  const context = resolveContext?.();
  const target = attempt.sessionTarget;
  const gatewayRegistry = getActivePluginRegistry();
  const registry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? gatewayRegistry;
  // Prepared runs can own a separate registry; both it and the Gateway policy owner must stay live.
  const pluginOwners = [gatewayRegistry, registry].map((owner) => {
    const record = owner?.plugins.find((candidate) => candidate.id === pluginId);
    return owner && record
      ? capturePluginLifecycleAuthority(owner, record, { scopedRuntime: owner !== gatewayRegistry })
      : undefined;
  });
  const assertPlacementCurrent = getPluginRuntimeGatewayRequestScope()?.assertNodeExecutionCurrent;
  if (
    !context ||
    !target?.storePath ||
    !attempt.agentId ||
    !attempt.sessionKey ||
    !attempt.sessionId ||
    !assertPlacementCurrent
  ) {
    return {};
  }
  const session = {
    agentId: attempt.agentId,
    sessionKey: attempt.sessionKey,
    storePath: target.storePath,
  };
  const assertRequestCurrent = (request: SessionNodeRequest) => {
    if (
      request.source === "session-full" &&
      (!admittedFull || !requiredNodeCommands.has(request.command))
    ) {
      throw new Error("admitted node execution authority does not cover this command");
    }
    assertActive();
    // This read can only revoke the admitted permission. It cannot create Full authority.
    const entry = loadSessionEntryReadOnly(session);
    if (
      signal.aborted ||
      getActivePluginRegistry() !== gatewayRegistry ||
      pluginOwners.some((isCurrent) => !isCurrent?.()) ||
      (request.source === "session-full" &&
        (attempt.permissionMode !== "full" || !requiredNodeCommands.has(request.command))) ||
      (resolveContext && resolveContext() !== context) ||
      request.pluginId !== pluginId ||
      !entry ||
      entry.sessionId !== attempt.sessionId ||
      (request.source === "session-full" && entry.permissionMode !== "full") ||
      request.workspace.sessionKey !== attempt.sessionKey ||
      request.workspace.sessionId !== attempt.sessionId
    ) {
      throw new Error("admitted node execution authority is no longer current");
    }
    assertPlacementCurrent({ ...request, runId: attempt.runId, agentId: session.agentId });
  };
  const invokeWithSessionNodeAuthority: SessionNodeInvocation = async (request, invoke) => {
    if (
      request.source === "session-full" &&
      (!admittedFull || !requiredNodeCommands.has(request.command))
    ) {
      return undefined;
    }
    const assertCurrent = () => assertRequestCurrent(request);
    assertCurrent();
    const result = await invoke(assertCurrent, signal);
    assertCurrent();
    return result;
  };
  return {
    invokeWithSessionNodeAuthority,
    nodePlacementGrantAuthority: {
      agentId: session.agentId,
      sessionKey: attempt.sessionKey,
      runId: attempt.runId,
      assertCurrent: (request) => assertRequestCurrent({ ...request, source: "human-approved" }),
    },
  };
}
