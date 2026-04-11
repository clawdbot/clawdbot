import type { OpenClawConfig } from "../../config/config.js";
import type { AgentEmbeddedHarnessConfig } from "../../config/types.agents-shared.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { listAgentEntries, resolveSessionAgentIds } from "../agent-scope.js";
import type { CompactEmbeddedPiSessionParams } from "../pi-embedded-runner/compact.types.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../pi-embedded-runner/run/types.js";
import {
  normalizeEmbeddedAgentRuntime,
  resolveEmbeddedAgentHarnessFallback,
  resolveEmbeddedAgentRuntime,
  type EmbeddedAgentHarnessFallback,
  type EmbeddedAgentRuntime,
} from "../pi-embedded-runner/runtime.js";
import type { EmbeddedPiCompactResult } from "../pi-embedded-runner/types.js";
import { createPiAgentHarness } from "./builtin-pi.js";
import { listRegisteredAgentHarnesses } from "./registry.js";
import type { AgentHarness, AgentHarnessSupport } from "./types.js";

const log = createSubsystemLogger("agents/harness");

type AgentHarnessPolicy = {
  runtime: EmbeddedAgentRuntime;
  fallback: EmbeddedAgentHarnessFallback;
};

function listPluginAgentHarnesses(): AgentHarness[] {
  return listRegisteredAgentHarnesses().map((entry) => entry.harness);
}

function compareHarnessSupport(
  left: { harness: AgentHarness; support: AgentHarnessSupport & { supported: true } },
  right: { harness: AgentHarness; support: AgentHarnessSupport & { supported: true } },
): number {
  const priorityDelta = (right.support.priority ?? 0) - (left.support.priority ?? 0);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return left.harness.id.localeCompare(right.harness.id);
}

export function selectAgentHarness(params: {
  provider: string;
  modelId?: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): AgentHarness {
  const policy = resolveAgentHarnessPolicy(params);
  // PI is intentionally not part of the plugin candidate list. It is the legacy
  // fallback path, so `fallback: "none"` can prove that only plugin harnesses run.
  const pluginHarnesses = listPluginAgentHarnesses();
  const piHarness = createPiAgentHarness();
  const runtime = policy.runtime;
  if (runtime === "pi") {
    return piHarness;
  }
  if (runtime !== "auto") {
    const forced = pluginHarnesses.find((entry) => entry.id === runtime);
    if (forced) {
      return forced;
    }
    if (policy.fallback === "none") {
      throw new Error(
        `Requested agent harness "${runtime}" is not registered and PI fallback is disabled.`,
      );
    }
    log.warn("requested agent harness is not registered; falling back to embedded PI backend", {
      requestedRuntime: runtime,
    });
    return piHarness;
  }

  const supported = pluginHarnesses
    .map((harness) => ({
      harness,
      support: harness.supports({
        provider: params.provider,
        modelId: params.modelId,
        requestedRuntime: runtime,
      }),
    }))
    .filter(
      (
        entry,
      ): entry is {
        harness: AgentHarness;
        support: AgentHarnessSupport & { supported: true };
      } => entry.support.supported,
    )
    .toSorted(compareHarnessSupport);

  const selected = supported[0]?.harness;
  if (selected) {
    return selected;
  }
  if (policy.fallback === "none") {
    throw new Error(
      `No registered agent harness supports ${formatProviderModel(params)} and PI fallback is disabled.`,
    );
  }
  return piHarness;
}

export async function runAgentHarnessAttemptWithFallback(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const policy = resolveAgentHarnessPolicy({
    provider: params.provider,
    modelId: params.modelId,
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const harness = selectAgentHarness({
    provider: params.provider,
    modelId: params.modelId,
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  if (harness.id === "pi") {
    return harness.runAttempt(params);
  }

  try {
    return await harness.runAttempt(params);
  } catch (error) {
    if (policy.runtime !== "auto" || policy.fallback === "none") {
      throw error;
    }
    log.warn(`${harness.label} failed; falling back to embedded PI backend`, { error });
    return createPiAgentHarness().runAttempt(params);
  }
}

export async function maybeCompactAgentHarnessSession(
  params: CompactEmbeddedPiSessionParams,
): Promise<EmbeddedPiCompactResult | undefined> {
  const harness = selectAgentHarness({
    provider: params.provider ?? "",
    modelId: params.model,
    config: params.config,
    sessionKey: params.sessionKey,
  });
  if (!harness.compact) {
    return undefined;
  }
  return harness.compact(params);
}

export function resolveAgentHarnessPolicy(params: {
  provider?: string;
  modelId?: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  env?: NodeJS.ProcessEnv;
}): AgentHarnessPolicy {
  const env = params.env ?? process.env;
  // Harness policy can be session-scoped because users may switch between agents
  // with different strictness requirements inside the same gateway process.
  const agentPolicy = resolveAgentEmbeddedHarnessConfig(params.config, {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const defaultsPolicy = params.config?.agents?.defaults?.embeddedHarness;
  const runtime = env.OPENCLAW_AGENT_RUNTIME?.trim()
    ? resolveEmbeddedAgentRuntime(env)
    : normalizeEmbeddedAgentRuntime(agentPolicy?.runtime ?? defaultsPolicy?.runtime);
  return {
    runtime,
    fallback:
      resolveEmbeddedAgentHarnessFallback(env) ??
      normalizeAgentHarnessFallback(agentPolicy?.fallback ?? defaultsPolicy?.fallback),
  };
}

function resolveAgentEmbeddedHarnessConfig(
  config: OpenClawConfig | undefined,
  params: { agentId?: string; sessionKey?: string },
): AgentEmbeddedHarnessConfig | undefined {
  if (!config) {
    return undefined;
  }
  const { sessionAgentId } = resolveSessionAgentIds({
    config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  return listAgentEntries(config).find((entry) => normalizeAgentId(entry.id) === sessionAgentId)
    ?.embeddedHarness;
}

function normalizeAgentHarnessFallback(
  value: AgentEmbeddedHarnessConfig["fallback"] | undefined,
): EmbeddedAgentHarnessFallback {
  return value === "none" ? "none" : "pi";
}

function formatProviderModel(params: { provider: string; modelId?: string }): string {
  return params.modelId ? `${params.provider}/${params.modelId}` : params.provider;
}
