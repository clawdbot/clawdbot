import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRecord } from "../utils.js";
import { OPENCLAW_AGENT_RUNTIME_ID, isDefaultAgentRuntimeId } from "./agent-runtime-id.js";
import { normalizeOptionalAgentRuntimeId } from "./agent-runtime-id.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import { normalizeProviderId } from "./provider-id.js";

function normalizeConfiguredRuntimeId(value: unknown): string | undefined {
  return normalizeOptionalAgentRuntimeId(value);
}

function isSelectablePluginRuntime(runtime: string | undefined): runtime is string {
  return (
    !!runtime &&
    !isDefaultAgentRuntimeId(runtime) &&
    normalizeOptionalAgentRuntimeId(runtime) !== OPENCLAW_AGENT_RUNTIME_ID
  );
}

function listAgentModelRefs(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!isRecord(value)) {
    return [];
  }
  const refs: string[] = [];
  if (typeof value.primary === "string") {
    refs.push(value.primary);
  }
  if (Array.isArray(value.fallbacks)) {
    for (const fallback of value.fallbacks) {
      if (typeof fallback === "string") {
        refs.push(fallback);
      }
    }
  }
  return refs;
}

function pushAgentModelRefs(refs: string[], value: unknown): void {
  for (const ref of listAgentModelRefs(value)) {
    refs.push(ref);
  }
}

function parseConfiguredModelRef(
  value: unknown,
): { provider: string; modelId: string } | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return undefined;
  }
  return {
    provider: normalizeProviderId(trimmed.slice(0, slash)),
    modelId: trimmed.slice(slash + 1).trim(),
  };
}

function resolveConfiguredModelHarnessRuntime(params: {
  config: OpenClawConfig;
  includeImplicitRuntimePreferences: boolean;
  modelRef: string;
  agentId?: string;
}): string | undefined {
  const parsed = parseConfiguredModelRef(params.modelRef);
  if (!parsed) {
    return undefined;
  }
  const policy = resolveAgentHarnessPolicy({
    config: params.config,
    provider: parsed.provider,
    modelId: parsed.modelId,
    agentId: params.agentId,
  });
  if (!params.includeImplicitRuntimePreferences && policy.runtimeSource === "implicit") {
    return undefined;
  }
  const runtime = normalizeConfiguredRuntimeId(policy.runtime);
  return isSelectablePluginRuntime(runtime) ? runtime : undefined;
}

function pushConfiguredModelRuntimeIds(config: OpenClawConfig, runtimes: Set<string>): void {
  for (const providerConfig of Object.values(config.models?.providers ?? {})) {
    const providerRuntime = normalizeConfiguredRuntimeId(providerConfig?.agentRuntime?.id);
    if (isSelectablePluginRuntime(providerRuntime)) {
      runtimes.add(providerRuntime);
    }
    for (const modelConfig of providerConfig?.models ?? []) {
      const modelRuntime = normalizeConfiguredRuntimeId(modelConfig?.agentRuntime?.id);
      if (isSelectablePluginRuntime(modelRuntime)) {
        runtimes.add(modelRuntime);
      }
    }
  }
  const pushModelMapRuntimeIds = (models: unknown) => {
    if (!isRecord(models)) {
      return;
    }
    for (const entry of Object.values(models)) {
      if (!isRecord(entry)) {
        continue;
      }
      const runtime = normalizeConfiguredRuntimeId(
        isRecord(entry.agentRuntime) ? entry.agentRuntime.id : undefined,
      );
      if (isSelectablePluginRuntime(runtime)) {
        runtimes.add(runtime);
      }
    }
  };
  pushModelMapRuntimeIds(config.agents?.defaults?.models);
  const agents = Array.isArray(config.agents?.list) ? config.agents.list : [];
  for (const agent of agents) {
    pushModelMapRuntimeIds(isRecord(agent) ? agent.models : undefined);
  }
}

function pushConfiguredAgentModelRuntimeIds(
  config: OpenClawConfig,
  runtimes: Set<string>,
  includeImplicitRuntimePreferences: boolean,
): void {
  const pushModelRefs = (modelRefs: string[], agentId?: string) => {
    for (const modelRef of modelRefs) {
      const runtime = resolveConfiguredModelHarnessRuntime({
        config,
        includeImplicitRuntimePreferences,
        modelRef,
        agentId,
      });
      if (runtime) {
        runtimes.add(runtime);
      }
    }
  };
  const pushModelMapRefs = (models: unknown, agentId?: string) => {
    if (!isRecord(models)) {
      return;
    }
    pushModelRefs(Object.keys(models), agentId);
  };

  const defaultsModel = config.agents?.defaults?.model;
  const defaultsModelRefs: string[] = [];
  pushAgentModelRefs(defaultsModelRefs, defaultsModel);
  pushModelRefs(defaultsModelRefs);
  pushModelMapRefs(config.agents?.defaults?.models);

  if (!Array.isArray(config.agents?.list)) {
    return;
  }
  for (const agent of config.agents.list) {
    if (!isRecord(agent)) {
      continue;
    }
    const agentId = typeof agent.id === "string" ? agent.id : undefined;
    const selectedModelRefs: string[] = [];
    pushAgentModelRefs(selectedModelRefs, agent.model ?? defaultsModel);
    pushModelRefs(selectedModelRefs, agentId);
    pushModelMapRefs(agent.models, agentId);
  }
}

export type ConfiguredAgentHarnessRuntimeOptions = {
  includeImplicitRuntimePreferences?: boolean;
};

export function collectConfiguredAgentHarnessRuntimes(
  config: OpenClawConfig,
  options: ConfiguredAgentHarnessRuntimeOptions = {},
): string[] {
  const runtimes = new Set<string>();
  const includeImplicitRuntimePreferences = options.includeImplicitRuntimePreferences ?? true;

  pushConfiguredModelRuntimeIds(config, runtimes);
  pushConfiguredAgentModelRuntimeIds(config, runtimes, includeImplicitRuntimePreferences);

  return [...runtimes].toSorted((left, right) => left.localeCompare(right));
}
