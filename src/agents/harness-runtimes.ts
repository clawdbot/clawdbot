import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { isRecord } from "../utils.js";
import { resolveAgentRuntimePolicy } from "./agent-runtime-policy.js";
import { isCliRuntimeAlias } from "./model-runtime-aliases.js";
import { modelSelectionRequiresCodexRuntime } from "./openai-codex-routing.js";
import { normalizeEmbeddedAgentRuntime } from "./pi-embedded-runner/runtime.js";

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

function hasCodexRuntimeModelRef(config: OpenClawConfig, value: unknown): boolean {
  return listAgentModelRefs(value).some((ref) => {
    return modelSelectionRequiresCodexRuntime({ model: ref, config });
  });
}

function openAIModelUsesImplicitCodexHarness(runtime: string | undefined): boolean {
  if (!runtime || runtime === "auto") {
    return true;
  }
  if (runtime === "pi") {
    return false;
  }
  return runtime === "codex" || isCliRuntimeAlias(runtime);
}

export function collectConfiguredAgentHarnessRuntimes(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): string[] {
  const runtimes = new Set<string>();
  const pushRuntime = (value: unknown) => {
    const normalized = normalizeRuntimeId(value);
    if (!normalized || normalized === "auto" || normalized === "pi") {
      return;
    }
    runtimes.add(normalized);
  };
  const pushCodexForOpenAIModel = (model: unknown, runtime: string | undefined) => {
    if (hasCodexRuntimeModelRef(config, model) && openAIModelUsesImplicitCodexHarness(runtime)) {
      runtimes.add("codex");
    }
  };

  const envRuntime = normalizeRuntimeId(env.OPENCLAW_AGENT_RUNTIME);
  const defaultsRuntime = normalizeRuntimeId(
    resolveAgentRuntimePolicy(config.agents?.defaults)?.id,
  );
  const defaultsModel = config.agents?.defaults?.model;
  pushRuntime(defaultsRuntime);
  pushCodexForOpenAIModel(defaultsModel, envRuntime ?? defaultsRuntime);
  if (Array.isArray(config.agents?.list)) {
    for (const agent of config.agents.list) {
      if (!isRecord(agent)) {
        continue;
      }
      const agentRuntime = normalizeRuntimeId(resolveAgentRuntimePolicy(agent)?.id);
      pushRuntime(agentRuntime);
      pushCodexForOpenAIModel(
        agent.model ?? defaultsModel,
        envRuntime ?? agentRuntime ?? defaultsRuntime,
      );
    }
  }
  pushRuntime(envRuntime);

  return [...runtimes].toSorted((left, right) => left.localeCompare(right));
}
