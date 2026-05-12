import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { isRecord } from "../utils.js";
import { resolveModelRuntimePolicy } from "./model-runtime-policy.js";
import { modelSelectionShouldEnsureCodexPlugin } from "./openai-codex-routing.js";
import { normalizeEmbeddedAgentRuntime } from "./pi-embedded-runner/runtime.js";
import { normalizeProviderId } from "./provider-id.js";

function normalizeRuntimeId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const lower = normalizeOptionalLowercaseString(value);
  if (!lower) {
    return undefined;
  }
  return normalizeOptionalLowercaseString(normalizeEmbeddedAgentRuntime(lower));
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

function hasOpenAIModelRef(config: OpenClawConfig, value: unknown, agentId?: string): boolean {
  return listAgentModelRefs(value).some((ref) => {
    if (!modelSelectionShouldEnsureCodexPlugin({ model: ref, config })) {
      return false;
    }
    const parsed = parseConfiguredModelRef(ref);
    const policy = resolveModelRuntimePolicy({
      config,
      provider: parsed?.provider,
      modelId: parsed?.modelId,
      agentId,
    });
    const runtime = normalizeRuntimeId(policy.policy?.id);
    return !runtime || runtime === "auto" || runtime === "codex";
  });
}

function pushConfiguredModelRuntimeIds(config: OpenClawConfig, runtimes: Set<string>): void {
  for (const providerConfig of Object.values(config.models?.providers ?? {})) {
    const providerRuntime = normalizeRuntimeId(providerConfig?.agentRuntime?.id);
    if (providerRuntime && providerRuntime !== "auto" && providerRuntime !== "pi") {
      runtimes.add(providerRuntime);
    }
    for (const modelConfig of providerConfig?.models ?? []) {
      const modelRuntime = normalizeRuntimeId(modelConfig?.agentRuntime?.id);
      if (modelRuntime && modelRuntime !== "auto" && modelRuntime !== "pi") {
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
      const runtime = normalizeRuntimeId(
        isRecord(entry.agentRuntime) ? entry.agentRuntime.id : undefined,
      );
      if (runtime && runtime !== "auto" && runtime !== "pi") {
        runtimes.add(runtime);
      }
    }
  };
  pushModelMapRuntimeIds(config.agents?.defaults?.models);
  const agents = Array.isArray(config.agents?.list) ? config.agents.list : [];
  for (const agent of agents) {
    pushModelMapRuntimeIds(agent.models);
  }
}

function pushLegacyAgentRuntimeIds(config: OpenClawConfig, runtimes: Set<string>): void {
  const pushRuntimeId = (value: unknown) => {
    const runtime = normalizeRuntimeId(value);
    if (runtime && runtime !== "auto" && runtime !== "pi") {
      runtimes.add(runtime);
    }
  };

  pushRuntimeId(config.agents?.defaults?.agentRuntime?.id);
  const agents = Array.isArray(config.agents?.list) ? config.agents.list : [];
  for (const agent of agents) {
    pushRuntimeId(agent.agentRuntime?.id);
  }
}

export type ConfiguredAgentHarnessRuntimeOptions = {
  includeEnvRuntime?: boolean;
  includeLegacyAgentRuntimes?: boolean;
};

export function collectConfiguredAgentHarnessRuntimes(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  options: ConfiguredAgentHarnessRuntimeOptions = {},
): string[] {
  const runtimes = new Set<string>();
  const includeEnvRuntime = options.includeEnvRuntime ?? true;
  const includeLegacyAgentRuntimes = options.includeLegacyAgentRuntimes ?? true;
  const pushCodexForOpenAIModel = (model: unknown, agentId?: string) => {
    if (hasOpenAIModelRef(config, model, agentId)) {
      runtimes.add("codex");
    }
  };

  if (includeEnvRuntime) {
    const envRuntime = normalizeRuntimeId(env.OPENCLAW_AGENT_RUNTIME);
    if (envRuntime && envRuntime !== "auto" && envRuntime !== "pi") {
      runtimes.add(envRuntime);
    }
  }
  pushConfiguredModelRuntimeIds(config, runtimes);
  if (includeLegacyAgentRuntimes) {
    pushLegacyAgentRuntimeIds(config, runtimes);
  }
  const defaultsModel = config.agents?.defaults?.model;
  pushCodexForOpenAIModel(defaultsModel);
  if (Array.isArray(config.agents?.list)) {
    for (const agent of config.agents.list) {
      if (!isRecord(agent)) {
        continue;
      }
      pushCodexForOpenAIModel(
        agent.model ?? defaultsModel,
        typeof agent.id === "string" ? agent.id : undefined,
      );
    }
  }

  return [...runtimes].toSorted((left, right) => left.localeCompare(right));
}
