import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { CompactEmbeddedPiSessionParams } from "../pi-embedded-runner/compact.types.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../pi-embedded-runner/run/types.js";
import type { EmbeddedPiCompactResult } from "../pi-embedded-runner/types.js";
import { createPiAgentHarness } from "./builtin-pi.js";
import {
  resolveAgentHarnessPolicy as resolveConfiguredAgentHarnessPolicy,
  type AgentHarnessPolicy,
} from "./policy.js";
import { getRegisteredAgentHarness, listRegisteredAgentHarnesses } from "./registry.js";
import type { AgentHarness, AgentHarnessSupport } from "./types.js";
import { adaptAgentHarnessToV2, runAgentHarnessV2LifecycleAttempt } from "./v2.js";

const log = createSubsystemLogger("agents/harness");
export { resolveAgentHarnessPolicy } from "./policy.js";
export type { AgentHarnessPolicy };

type AgentHarnessSelectionCandidate = {
  id: string;
  label: string;
  pluginId?: string;
  supported?: boolean;
  priority?: number;
  reason?: string;
};

type AgentHarnessSelectionDecision = {
  harness: AgentHarness;
  policy: AgentHarnessPolicy;
  selectedHarnessId: string;
  selectedReason:
    | "forced_pi"
    | "forced_plugin"
    // Implicit Codex preference found no registered Codex harness, so PI handled the run.
    | "implicit_plugin_unavailable_pi"
    // Auto mode chose a registered plugin harness that supports the provider/model.
    | "auto_plugin"
    // Auto mode found no supporting plugin harness, so PI handled the run.
    | "auto_pi";
  candidates: AgentHarnessSelectionCandidate[];
};

function listPluginAgentHarnesses(): AgentHarness[] {
  return listRegisteredAgentHarnesses().map((entry) => entry.harness);
}

export function resolveAvailableAgentHarnessPolicy(params: {
  provider?: string;
  modelId?: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  env?: NodeJS.ProcessEnv;
}): AgentHarnessPolicy {
  return applyAgentHarnessAvailabilityPolicy(resolveConfiguredAgentHarnessPolicy(params));
}

function applyAgentHarnessAvailabilityPolicy(policy: AgentHarnessPolicy): AgentHarnessPolicy {
  if (
    policy.runtime === "codex" &&
    policy.runtimeSource === "implicit" &&
    !getRegisteredAgentHarness("codex")
  ) {
    return {
      ...policy,
      runtime: "pi",
    };
  }
  return policy;
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
  agentHarnessId?: string;
  agentHarnessRuntimeOverride?: string;
}): AgentHarness {
  return selectAgentHarnessDecision(params).harness;
}

function selectAgentHarnessDecision(params: {
  provider: string;
  modelId?: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  agentHarnessId?: string;
  agentHarnessRuntimeOverride?: string;
}): AgentHarnessSelectionDecision {
  const resolvedPolicy = resolveConfiguredAgentHarnessPolicy(params);
  const runtimeOverride = params.agentHarnessRuntimeOverride?.trim();
  const policy =
    runtimeOverride && runtimeOverride !== "auto" && runtimeOverride !== "default"
      ? ({
          ...resolvedPolicy,
          runtime: runtimeOverride,
          runtimeSource: "model",
        } as AgentHarnessPolicy)
      : resolvedPolicy;
  // PI is intentionally not part of the plugin candidate list. Explicit plugin
  // runtimes fail closed; only `auto` may route an unmatched turn to PI.
  const pluginHarnesses = listPluginAgentHarnesses();
  const piHarness = createPiAgentHarness();
  const runtime = policy.runtime;
  if (runtime === "pi") {
    return buildSelectionDecision({
      harness: piHarness,
      policy,
      selectedReason: "forced_pi",
      candidates: listHarnessCandidates(pluginHarnesses),
    });
  }
  if (runtime !== "auto") {
    const forced = pluginHarnesses.find((entry) => entry.id === runtime);
    if (forced) {
      return buildSelectionDecision({
        harness: forced,
        policy,
        selectedReason: "forced_plugin",
        candidates: listHarnessCandidates(pluginHarnesses),
      });
    }
    if (runtime === "codex" && policy.runtimeSource === "implicit") {
      return buildSelectionDecision({
        harness: piHarness,
        policy: {
          ...policy,
          runtime: "pi",
        },
        selectedReason: "implicit_plugin_unavailable_pi",
        candidates: listHarnessCandidates(pluginHarnesses),
      });
    }
    throw new Error(`Requested agent harness "${runtime}" is not registered.`);
  }

  const candidates = pluginHarnesses.map((harness) => ({
    harness,
    support: harness.supports({
      provider: params.provider,
      modelId: params.modelId,
      requestedRuntime: runtime,
    }),
  }));
  const supported = candidates
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
    return buildSelectionDecision({
      harness: selected,
      policy,
      selectedReason: "auto_plugin",
      candidates: candidates.map(toSelectionCandidate),
    });
  }
  return buildSelectionDecision({
    harness: piHarness,
    policy,
    selectedReason: "auto_pi",
    candidates: candidates.map(toSelectionCandidate),
  });
}

export async function runAgentHarnessAttempt(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const selection = selectAgentHarnessDecision({
    provider: params.provider,
    modelId: params.modelId,
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    agentHarnessId: params.agentHarnessId,
    agentHarnessRuntimeOverride: params.agentHarnessRuntimeOverride,
  });
  const harness = selection.harness;
  logAgentHarnessSelection(selection, {
    provider: params.provider,
    modelId: params.modelId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  const v2Harness = adaptAgentHarnessToV2(harness);
  if (harness.id === "pi") {
    return await runAgentHarnessV2LifecycleAttempt(v2Harness, params);
  }

  try {
    return await runAgentHarnessV2LifecycleAttempt(v2Harness, params);
  } catch (error) {
    log.warn(`${harness.label} failed; not falling back to embedded PI backend`, {
      harnessId: harness.id,
      provider: params.provider,
      modelId: params.modelId,
      error: formatErrorMessage(error),
    });
    throw error;
  }
}

function listHarnessCandidates(harnesses: AgentHarness[]): AgentHarnessSelectionCandidate[] {
  return harnesses.map((harness) => ({
    id: harness.id,
    label: harness.label,
    pluginId: harness.pluginId,
  }));
}

function toSelectionCandidate(entry: {
  harness: AgentHarness;
  support: AgentHarnessSupport;
}): AgentHarnessSelectionCandidate {
  return {
    id: entry.harness.id,
    label: entry.harness.label,
    pluginId: entry.harness.pluginId,
    supported: entry.support.supported,
    priority: entry.support.supported ? entry.support.priority : undefined,
    reason: entry.support.reason,
  };
}

function buildSelectionDecision(params: {
  harness: AgentHarness;
  policy: AgentHarnessPolicy;
  selectedReason: AgentHarnessSelectionDecision["selectedReason"];
  candidates: AgentHarnessSelectionCandidate[];
}): AgentHarnessSelectionDecision {
  return {
    harness: params.harness,
    policy: params.policy,
    selectedHarnessId: params.harness.id,
    selectedReason: params.selectedReason,
    candidates: params.candidates,
  };
}

function logAgentHarnessSelection(
  selection: AgentHarnessSelectionDecision,
  params: { provider: string; modelId?: string; sessionKey?: string; agentId?: string },
) {
  if (!log.isEnabled("debug")) {
    return;
  }
  log.debug("agent harness selected", {
    provider: params.provider,
    modelId: params.modelId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    selectedHarnessId: selection.selectedHarnessId,
    selectedReason: selection.selectedReason,
    runtime: selection.policy.runtime,
    candidates: selection.candidates,
  });
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
    if (harness.id !== "pi") {
      return {
        ok: false,
        compacted: false,
        reason: `Agent harness "${harness.id}" does not support compaction.`,
      };
    }
    return undefined;
  }
  return harness.compact(params);
}
