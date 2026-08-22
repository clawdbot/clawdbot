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

// Stage the smallest config shape that expresses the selection. The gateway
// resolver honors a bare string, { primary, fallbacks }, and { fallbacks }
// with no primary (agent-scope.ts); staging must write all three or an
// authored piece of the selection silently disappears.
function stageModelShape(
  runtimeConfig: RuntimeConfig,
  path: Array<string | number>,
  primary: string | null,
  fallbacks: string[] | null,
) {
  if (primary && fallbacks) {
    runtimeConfig.patchForm(path, { primary, fallbacks });
  } else if (primary) {
    runtimeConfig.patchForm(path, primary);
  } else if (fallbacks) {
    runtimeConfig.patchForm(path, { fallbacks });
  } else {
    runtimeConfig.removeFormValue(path);
  }
}

function existingModelParts(existing: unknown): {
  primary: string | null;
  fallbacks: string[] | null;
} {
  if (typeof existing === "string") {
    return { primary: existing.trim() || null, fallbacks: null };
  }
  if (existing && typeof existing === "object") {
    const record = existing as { primary?: unknown; fallbacks?: unknown };
    return {
      primary: typeof record.primary === "string" ? record.primary.trim() || null : null,
      fallbacks: Array.isArray(record.fallbacks) ? (record.fallbacks as string[]) : null,
    };
  }
  return { primary: null, fallbacks: null };
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
  // Clearing the primary must not delete authored agent fallbacks: the
  // { fallbacks }-only shape stays representable.
  stageModelShape(runtimeConfig, entry.path, modelId, existingModelParts(entry.existing).fallbacks);
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
  const effective = resolveEffectiveModelFallbacks(resolved.entry?.model, resolved.defaults?.model);
  const existingTarget = runtimeConfig.agentEntry(agentId);
  const mustWrite = normalized.length > 0 || (effective?.length ?? 0) > 0 || existingTarget;
  const target = mustWrite
    ? (existingTarget ?? runtimeConfig.agentEntry(agentId, { ensure: true }))
    : null;
  if (!target) {
    return;
  }
  const entry = modelEntry(target);
  const primary =
    existingModelParts(entry.existing).primary ??
    resolveModelPrimary(resolved.entry?.model) ??
    resolveModelPrimary(resolved.defaults?.model) ??
    null;
  stageModelShape(runtimeConfig, entry.path, primary, normalized.length > 0 ? normalized : null);
}
