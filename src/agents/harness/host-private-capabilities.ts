import type { CronScheduledToolProjectionRequest } from "../exec-tool-target-pinning.js";
import type { AnyAgentTool } from "../tools/common.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

export type AgentHarnessScheduledToolProjectionFactory = (
  sourceTool: AnyAgentTool,
  projection: CronScheduledToolProjectionRequest,
) => AnyAgentTool;

const scheduledToolProjectionCapabilities = new WeakMap<
  AgentHarnessHostCapabilities,
  Readonly<{
    ownerPluginId: string;
    create: AgentHarnessScheduledToolProjectionFactory;
  }>
>();

export function registerAgentHarnessScheduledToolProjectionCapability(params: {
  hostCapabilities: AgentHarnessHostCapabilities;
  ownerPluginId: string;
  create: AgentHarnessScheduledToolProjectionFactory;
}): void {
  scheduledToolProjectionCapabilities.set(
    params.hostCapabilities,
    Object.freeze({ ownerPluginId: params.ownerPluginId, create: params.create }),
  );
}

/** Resolves a private issuer only for the exact authoritative plugin owner. */
export function resolveAgentHarnessScheduledToolProjectionCapability(params: {
  hostCapabilities: AgentHarnessHostCapabilities;
  ownerPluginId: string;
}): AgentHarnessScheduledToolProjectionFactory | undefined {
  const capability = scheduledToolProjectionCapabilities.get(params.hostCapabilities);
  return capability?.ownerPluginId === params.ownerPluginId ? capability.create : undefined;
}
