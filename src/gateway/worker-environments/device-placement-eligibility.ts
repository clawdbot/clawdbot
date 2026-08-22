import type { DevicePlacementRequirement } from "../../agents/harness/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "../node-command-policy.js";
import { deviceUnavailableText, resolveDeviceWorkerAvailability } from "./device-provider.js";

type DevicePlacementEligibility = { ok: true } | { ok: false; error: string };

export async function resolveDevicePlacementEligibility(params: {
  environmentService: object | undefined;
  deviceId: string;
  runtimeId?: string;
  requirement: DevicePlacementRequirement | undefined;
  config: OpenClawConfig;
  currentNode?: {
    nodeId: string;
    connId?: string;
    pairingGeneration?: string;
    platform?: string;
    deviceFamily?: string;
  };
}): Promise<DevicePlacementEligibility> {
  const { deviceId, requirement } = params;
  if (!requirement) {
    return {
      ok: false,
      error: `runtime ${params.runtimeId ?? "selection"} does not support paired-device placement; select a compatible runtime or cloud worker provider`,
    };
  }
  const availability = await resolveDeviceWorkerAvailability(params.environmentService, deviceId);
  if (!availability.available || !availability.node) {
    return { ok: false, error: deviceUnavailableText(deviceId, availability) };
  }
  const node = availability.node;
  if (
    params.currentNode &&
    (params.currentNode.nodeId !== node.nodeId ||
      (params.currentNode.connId && params.currentNode.connId !== node.connId) ||
      (params.currentNode.pairingGeneration &&
        params.currentNode.pairingGeneration !== node.pairingGeneration))
  ) {
    return {
      ok: false,
      error: deviceUnavailableText(deviceId, {
        available: false,
        unavailableReason: "disconnected",
      }),
    };
  }
  const declaredCommands = [...node.commands];
  const allowlist = resolveNodeCommandAllowlist(params.config, {
    ...(params.currentNode?.platform ? { platform: params.currentNode.platform } : {}),
    ...(params.currentNode?.deviceFamily ? { deviceFamily: params.currentNode.deviceFamily } : {}),
    commands: declaredCommands,
    approvedCommands: declaredCommands,
  });
  for (const command of requirement.requiredNodeCommands) {
    if (!isNodeCommandAllowed({ command, declaredCommands, allowlist }).ok) {
      return {
        ok: false,
        error: `paired-device command ${command} is not enabled or approved for ${deviceId}; enable it in gateway.nodes.commands.allow and approve the command on the node`,
      };
    }
  }
  if (requirement.consumesWorkerSlot && node.workerHost.capacity.available <= 0) {
    return {
      ok: false,
      error: deviceUnavailableText(deviceId, {
        available: false,
        unavailableReason: "at-capacity",
      }),
    };
  }
  return { ok: true };
}
