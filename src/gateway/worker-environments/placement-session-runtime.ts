import {
  isDefaultAgentRuntimeId,
  OPENCLAW_AGENT_RUNTIME_ID,
} from "../../agents/agent-runtime-id.js";
import { getRegisteredAgentHarness } from "../../agents/harness/registry.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { resolvePersistedSessionRuntimeId } from "../../agents/session-runtime-compat.js";
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
  const persistedRuntime = resolvePersistedSessionRuntimeId(params.entry);
  if (persistedRuntime && !isDefaultAgentRuntimeId(persistedRuntime)) {
    return persistedRuntime;
  }
  const selectedModel = resolveSessionModelRef(params.cfg, params.entry, params.agentId);
  return resolveEffectiveAgentRuntime({
    cfg: params.cfg,
    provider: selectedModel.provider,
    modelId: selectedModel.model,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
}

export function resolveWorkerPlacementExecutionMode(
  runtime: string,
): WorkerPlacementExecutionMode | undefined {
  return resolveWorkerPlacementCapabilities(runtime).executionMode;
}

function resolveWorkerPlacementCapabilities(runtime: string): {
  executionMode?: WorkerPlacementExecutionMode;
  devicePlacementSupported: boolean;
} {
  const runtimeId = runtime.trim();
  if (runtimeId === OPENCLAW_AGENT_RUNTIME_ID) {
    return { executionMode: "worker-turn", devicePlacementSupported: true };
  }
  const placement = getRegisteredAgentHarness(runtimeId)?.harness.cloudPlacement;
  return {
    ...(placement ? { executionMode: placement.mode } : {}),
    devicePlacementSupported: placement?.devicePlacement === true,
  };
}

export function supportsWorkerPlacementOnDevice(runtime: string): boolean {
  return resolveWorkerPlacementCapabilities(runtime).devicePlacementSupported;
}

export function projectWorkerPlacementAgentRuntime(
  runtime: GatewayAgentRuntime,
): GatewayAgentRuntime & {
  cloudPlacementSupported: boolean;
  cloudPlacementExecutionMode?: WorkerPlacementExecutionMode;
  devicePlacementSupported: boolean;
} {
  const { source, ...identity } = runtime;
  const { executionMode, devicePlacementSupported } = resolveWorkerPlacementCapabilities(
    runtime.id,
  );
  return {
    ...identity,
    cloudPlacementSupported: executionMode !== undefined,
    ...(executionMode ? { cloudPlacementExecutionMode: executionMode } : {}),
    devicePlacementSupported,
    source,
  };
}
