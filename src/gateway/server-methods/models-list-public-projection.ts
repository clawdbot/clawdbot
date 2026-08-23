import { asPositiveSafeInteger as resolvePositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import type { ModelChoice } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayAgentRuntime } from "../../shared/session-types.js";
import { projectWorkerPlacementAgentRuntime } from "../worker-environments/placement-session-runtime.js";

type ModelsListEntry = Pick<
  ModelChoice,
  | "alias"
  | "contextWindow"
  | "contextWindowDefault"
  | "contextWindows"
  | "id"
  | "input"
  | "name"
  | "provider"
  | "reasoning"
  | "tags"
> & { available?: boolean; supportsTools?: boolean };

/** Keeps concrete route, auth, cost, and provider parameters out of public model rows. */
export function buildPublicModelProjection(entry: ModelCatalogEntry): ModelsListEntry {
  const contextWindow = resolvePositiveSafeInteger(entry.contextWindow);
  return {
    id: entry.id,
    name: entry.name,
    provider: entry.provider,
    ...(entry.alias ? { alias: entry.alias } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(entry.contextWindows ? { contextWindows: entry.contextWindows } : {}),
    ...(entry.contextWindowDefault ? { contextWindowDefault: entry.contextWindowDefault } : {}),
    ...(typeof entry.reasoning === "boolean" ? { reasoning: entry.reasoning } : {}),
    ...(typeof entry.compat?.supportsTools === "boolean"
      ? { supportsTools: entry.compat.supportsTools }
      : {}),
  };
}

export function resolveModelChoiceAgentRuntime(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry: ModelCatalogEntry;
}): GatewayAgentRuntime | undefined {
  const harnessPolicy = resolveAgentHarnessPolicy({
    provider: params.entry.provider,
    modelId: params.entry.id,
    modelApi: params.entry.api,
    modelBaseUrl: params.entry.baseUrl,
    config: params.cfg,
    agentId: params.agentId,
  });
  if (harnessPolicy.runtime === "auto") {
    return undefined;
  }
  return projectWorkerPlacementAgentRuntime({
    id: harnessPolicy.runtime,
    source: harnessPolicy.runtimeSource ?? "implicit",
  });
}
