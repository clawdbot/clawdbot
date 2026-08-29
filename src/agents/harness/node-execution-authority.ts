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

/** Full is admitted host authority, narrowed to one placement claim, never a request flag. */
export function createSessionNodeInvocation(
  attempt: HostAttempt,
  pluginId: string,
  requiredNodeCommands: ReadonlySet<string>,
  assertActive: () => void,
  signal: AbortSignal,
): SessionNodeInvocation | undefined {
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
    return undefined;
  }
  const session = {
    agentId: attempt.agentId,
    sessionKey: attempt.sessionKey,
    storePath: target.storePath,
  };
  return async (request, invoke) => {
    if (
      request.source === "session-full" &&
      (!admittedFull || !requiredNodeCommands.has(request.command))
    ) {
      return undefined;
    }
    const assertCurrent = () => {
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
    assertCurrent();
    const result = await invoke(assertCurrent, signal);
    assertCurrent();
    return result;
  };
}
