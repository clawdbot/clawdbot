import type { CronScheduledToolProjectionRequest } from "../exec-tool-target-pinning.js";
import type { AnyAgentTool } from "../tools/common.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

export type AgentHarnessScheduledToolProjectionFactory = (
  sourceTool: AnyAgentTool,
  projection: CronScheduledToolProjectionRequest,
) => AnyAgentTool;

export type AgentHarnessTtsProvenanceTransfer = <T extends object>(
  toolResult: unknown,
  attemptResult: T,
  eligibleMediaUrls: readonly string[],
) => T;

const scheduledToolProjectionCapabilities = new WeakMap<
  AgentHarnessHostCapabilities,
  Readonly<{
    ownerPluginId: string;
    create: AgentHarnessScheduledToolProjectionFactory;
  }>
>();
const ttsProvenanceTransferCapabilities = new WeakMap<
  AgentHarnessHostCapabilities,
  Readonly<{ ownerPluginId: string; transfer: AgentHarnessTtsProvenanceTransfer }>
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

export function registerAgentHarnessTtsProvenanceTransferCapability(params: {
  hostCapabilities: AgentHarnessHostCapabilities;
  ownerPluginId: string;
  transfer: AgentHarnessTtsProvenanceTransfer;
}): void {
  ttsProvenanceTransferCapabilities.set(
    params.hostCapabilities,
    Object.freeze({ ownerPluginId: params.ownerPluginId, transfer: params.transfer }),
  );
}

/** Resolves private TTS delivery transfer only for the exact authoritative plugin owner. */
export function resolveAgentHarnessTtsProvenanceTransferCapability(params: {
  hostCapabilities: AgentHarnessHostCapabilities;
  ownerPluginId: string;
}): AgentHarnessTtsProvenanceTransfer | undefined {
  const capability = ttsProvenanceTransferCapabilities.get(params.hostCapabilities);
  return capability?.ownerPluginId === params.ownerPluginId ? capability.transfer : undefined;
}
