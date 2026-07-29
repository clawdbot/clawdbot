// Plugin-managed reserved spawn adapter. Service-specific lease state stays in plugins.
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { isValidAgentId, parseAgentSessionKey } from "../routing/session-key.js";

export const spawnReservedSubagent: PluginRuntime["subagent"]["spawnReserved"] = async (params) => {
  const scope = getPluginRuntimeGatewayRequestScope();
  const pluginId =
    typeof scope?.pluginId === "string" && scope.pluginId.trim()
      ? scope.pluginId.trim()
      : undefined;
  if (!pluginId) {
    throw new Error("spawnReserved requires an active plugin runtime scope.");
  }
  const requesterSessionKey = params.requesterSessionKey.trim();
  const targetAgentId = params.targetAgentId.trim();
  const childSessionKey = params.childSessionKey.trim();
  const runId = params.runId.trim();
  const task = params.task.trim();
  if (
    requesterSessionKey !== params.requesterSessionKey ||
    !parseAgentSessionKey(requesterSessionKey)
  ) {
    throw new Error("spawnReserved requesterSessionKey must be a canonical agent session key.");
  }
  if (targetAgentId !== params.targetAgentId || !isValidAgentId(targetAgentId)) {
    throw new Error("spawnReserved targetAgentId is invalid.");
  }
  if (
    !childSessionKey ||
    childSessionKey !== params.childSessionKey ||
    !runId ||
    runId !== params.runId
  ) {
    throw new Error("spawnReserved childSessionKey and runId must be non-empty canonical values.");
  }
  if (!task) {
    throw new Error("spawnReserved task must be non-empty.");
  }
  const { spawnSubagentDirect } = await import("../agents/subagent-spawn.js");
  const result = await spawnSubagentDirect(
    {
      task,
      agentId: targetAgentId,
      ...(params.taskName !== undefined ? { taskName: params.taskName } : {}),
      ...(params.label !== undefined ? { label: params.label } : {}),
      mode: "run",
      ...(params.cleanup !== undefined ? { cleanup: params.cleanup } : {}),
      ...(params.context !== undefined ? { context: params.context } : {}),
      ...(params.lightContext !== undefined ? { lightContext: params.lightContext } : {}),
      expectsCompletionMessage: false,
    },
    {
      agentSessionKey: requesterSessionKey,
      authorizedTargetAgentId: targetAgentId,
      preallocatedChildSessionKey: childSessionKey,
      preallocatedRunId: runId,
      pluginOwnerId: pluginId,
    },
  );
  if (result.status !== "accepted") {
    throw new Error(result.error?.trim() || `reserved subagent spawn ${result.status}`);
  }
  if (result.childSessionKey !== childSessionKey || result.runId !== runId) {
    throw new Error("reserved subagent spawn returned different child or run identities.");
  }
  return {
    childSessionKey: result.childSessionKey,
    runId: result.runId,
    mode: "run",
  };
};
