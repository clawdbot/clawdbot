// Agent model selection staged against the runtime config form, split out of
// agents-page.ts to keep that page inside the TS LOC ratchet.
import type { ApplicationContext } from "../../app/context.ts";
import {
  resolveAgentConfig,
  resolveEffectiveModelFallbacks,
  resolveModelPrimary,
} from "../../lib/agents/display.ts";
import { currentConfigObject, findAgentConfigEntryIndex } from "../../lib/config/index.ts";
import { normalizeStringEntries } from "../../lib/string-coerce.ts";

type RuntimeConfig = ApplicationContext["runtimeConfig"];

function findAgentIndex(runtimeConfig: RuntimeConfig, agentId: string) {
  return findAgentConfigEntryIndex(currentConfigObject(runtimeConfig.state), agentId);
}

function modelEntry(runtimeConfig: RuntimeConfig, index: number) {
  const list = (
    currentConfigObject(runtimeConfig.state) as {
      agents?: { list?: unknown[] };
    } | null
  )?.agents?.list;
  const existing = Array.isArray(list)
    ? (list[index] as { model?: unknown } | undefined)?.model
    : undefined;
  return { path: ["agents", "list", index, "model"] as Array<string | number>, existing };
}

/** Stage a primary-model change; clearing falls back to the inherited default. */
export function stageAgentPrimaryModel(
  runtimeConfig: RuntimeConfig,
  agentId: string,
  modelId: string | null,
) {
  const index = modelId
    ? runtimeConfig.ensureAgentEntry(agentId)
    : findAgentIndex(runtimeConfig, agentId);
  if (index < 0) {
    return;
  }
  const entry = modelEntry(runtimeConfig, index);
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
  const index =
    normalized.length > 0
      ? primary
        ? runtimeConfig.ensureAgentEntry(agentId)
        : -1
      : (effective?.length ?? 0) > 0 || findAgentIndex(runtimeConfig, agentId) >= 0
        ? runtimeConfig.ensureAgentEntry(agentId)
        : -1;
  if (index < 0) {
    return;
  }
  const entry = modelEntry(runtimeConfig, index);
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
