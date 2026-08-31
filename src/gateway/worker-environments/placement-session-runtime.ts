import { OPENCLAW_AGENT_RUNTIME_ID } from "../../agents/agent-runtime-id.js";
import { getRegisteredAgentHarness } from "../../agents/harness/registry.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayAgentRuntime } from "../../shared/session-types.js";
import type { WorkerPlacementExecutionMode } from "./placement-record.js";

export function resolveWorkerPlacementSessionRuntime(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  agentId: string;
  sessionKey: string;
}): string {
  const selectedModel = resolveSessionModelRef(params.cfg, params.entry, params.agentId);
  return resolveEffectiveAgentRuntime({
    cfg: params.cfg,
    provider: selectedModel.provider,
    modelId: selectedModel.model,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionEntry: params.entry,
  });
}

export function resolveWorkerPlacementExecutionMode(
  runtime: string,
): WorkerPlacementExecutionMode | undefined {
  return resolveWorkerPlacementCapabilities(runtime).executionMode;
}

export function resolveWorkerPlacementCapabilities(runtime: string): {
  executionMode?: WorkerPlacementExecutionMode;
  devicePlacement?: NonNullable<GatewayAgentRuntime["devicePlacement"]>;
} {
  const runtimeId = runtime.trim();
  if (runtimeId === OPENCLAW_AGENT_RUNTIME_ID) {
    return {
      executionMode: "worker-turn",
      devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
    };
  }
  const placement = getRegisteredAgentHarness(runtimeId)?.harness.cloudPlacement;
  if (!placement) {
    return {};
  }
  const requirement = placement.devicePlacement;
  if (!requirement) {
    return { executionMode: placement.mode };
  }
  const requiredNodeCommands = [...new Set(requirement.requiredNodeCommands)].toSorted();
  // Dropping an oversized or malformed required command would silently grant incomplete authority.
  if (
    requiredNodeCommands.length > 32 ||
    requiredNodeCommands.some(
      (command) => command.length === 0 || command.length > 128 || command.trim() !== command,
    )
  ) {
    return { executionMode: placement.mode };
  }
  return {
    executionMode: placement.mode,
    devicePlacement: { requiredNodeCommands, consumesWorkerSlot: requirement.consumesWorkerSlot },
  };
}

export function projectWorkerPlacementAgentRuntime(
  runtime: GatewayAgentRuntime,
): GatewayAgentRuntime & {
  cloudPlacementSupported: boolean;
  cloudPlacementExecutionMode?: WorkerPlacementExecutionMode;
  devicePlacement?: NonNullable<GatewayAgentRuntime["devicePlacement"]>;
  devicePlacementSupported: boolean;
} {
  const { source, ...identity } = runtime;
  const { executionMode, devicePlacement } = resolveWorkerPlacementCapabilities(runtime.id);
  return {
    ...identity,
    cloudPlacementSupported: executionMode !== undefined,
    ...(executionMode ? { cloudPlacementExecutionMode: executionMode } : {}),
    ...(devicePlacement ? { devicePlacement } : {}),
    devicePlacementSupported: devicePlacement !== undefined,
    source,
  };
}
