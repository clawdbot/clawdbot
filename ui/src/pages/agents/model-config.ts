import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
// Agent model selection staged against the runtime config form, split out of
// agents-page.ts to keep that page inside the TS LOC ratchet.
import type { ApplicationContext } from "../../app/context.ts";
import {
  resolveAgentConfig,
  resolveEffectiveModelFallbacks,
  resolveModelPrimary,
} from "../../lib/agents/display.ts";
import {
  currentConfigObject,
  type AgentConfigEntryTarget,
} from "../../lib/config/config-state-model.ts";

type RuntimeConfig = ApplicationContext["runtimeConfig"];

function modelEntry(target: AgentConfigEntryTarget) {
  return {
    path: [...target.path, "model"] as Array<string | number>,
    existing: target.entry.model,
  };
}

/** Stage a primary-model change; clearing falls back to the inherited default. */
export function stageAgentPrimaryModel(
  runtimeConfig: RuntimeConfig,
  agentId: string,
  modelId: string | null,
) {
  const target = runtimeConfig.agentEntry(agentId, { ensure: Boolean(modelId) });
  if (!target) {
    return;
  }
  const entry = modelEntry(target);
  if (!modelId) {
    runtimeConfig.removeFormValue(entry.path);
  } else if (entry.existing && typeof entry.existing === "object") {
    const fallbacks = (entry.existing as { fallbacks?: unknown }).fallbacks;
    runtimeConfig.patchForm(entry.path, {
      primary: modelId,
      ...(Array.isArray(fallbacks) ? { fallbacks } : {}),
    });
  } else {
    runtimeConfig.patchForm(entry.path, modelId);
  }
}

/** Stage fallback-list edits, preserving the effective primary model shape. */
export function stageAgentModelFallbacks(
  runtimeConfig: RuntimeConfig,
  agentId: string,
  fallbacks: string[],
) {
  const config = currentConfigObject(runtimeConfig.state);
  const normalized = normalizeStringEntries(fallbacks);
  const resolved = resolveAgentConfig(config, agentId);
  const primary =
    resolveModelPrimary(resolved.entry?.model) ?? resolveModelPrimary(resolved.defaults?.model);
  const effective = resolveEffectiveModelFallbacks(resolved.entry?.model, resolved.defaults?.model);
  const existingTarget = runtimeConfig.agentEntry(agentId);
  const target =
    normalized.length > 0
      ? primary
        ? (existingTarget ?? runtimeConfig.agentEntry(agentId, { ensure: true }))
        : null
      : (effective?.length ?? 0) > 0 || existingTarget
        ? (existingTarget ?? runtimeConfig.agentEntry(agentId, { ensure: true }))
        : null;
  if (!target) {
    return;
  }
  const entry = modelEntry(target);
  const currentPrimary =
    typeof entry.existing === "string"
      ? entry.existing.trim()
      : entry.existing &&
          typeof entry.existing === "object" &&
          typeof (entry.existing as { primary?: unknown }).primary === "string"
        ? (entry.existing as { primary: string }).primary.trim()
        : "";
  if (normalized.length === 0) {
    if (currentPrimary || primary) {
      runtimeConfig.patchForm(entry.path, currentPrimary || primary);
    } else {
      runtimeConfig.removeFormValue(entry.path);
    }
  } else if (currentPrimary || primary) {
    runtimeConfig.patchForm(entry.path, {
      primary: currentPrimary || primary,
      fallbacks: normalized,
    });
  }
}
