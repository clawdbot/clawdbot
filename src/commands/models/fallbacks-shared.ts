/** Shared command implementation for text and image model fallback lists. */
import { resolveAgentModelFallbacksOverride } from "../../agents/agent-scope.js";
import { buildModelAliasIndex, resolveModelRefFromString } from "../../agents/model-selection.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { logConfigUpdated } from "../../config/logging.js";
import { resolveAgentModelFallbackValues, toAgentModelListLike } from "../../config/model-input.js";
import type { AgentModelEntryConfig } from "../../config/types.agent-defaults.js";
import type { AgentModelConfig } from "../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { loadModelsConfig } from "./load-config.js";
import {
  DEFAULT_PROVIDER,
  ensureFlagCompatibility,
  mergePrimaryFallbackConfig,
  modelKey,
  resolveKnownAgentId,
  resolveModelTarget,
  resolveModelKeysFromEntries,
  upsertCanonicalModelConfigEntry,
  updateConfig,
} from "./shared.js";

type DefaultsFallbackKey = "model" | "imageModel";

/**
 * Options shared by fallback subcommands; `agent` scopes text-model fallback
 * reads/writes to one agent. Image model fallbacks are global defaults only,
 * so the image commands never pass an agent id.
 */
type FallbackScopeOpts = { agent?: string };

function listCommandForFallbackKey(key: DefaultsFallbackKey): string {
  return key === "imageModel"
    ? "openclaw models image-fallbacks list"
    : "openclaw models fallbacks list";
}

function withFallbacks(existing: AgentModelConfig | undefined, fallbacks: string[]): AgentModelConfig {
  if (typeof existing === "string") {
    return { primary: existing, fallbacks };
  }
  return { ...existing, fallbacks };
}

/**
 * An explicit --agent write always creates an agent-local override. Falling
 * through to defaults would silently change every inheriting agent.
 */
function patchAgentFallbacks(
  cfg: OpenClawConfig,
  agentId: string,
  fallbacks: string[],
): OpenClawConfig {
  const next = structuredClone(cfg);
  next.agents ??= {};
  const entries = (next.agents.list ??= []);
  let entry = entries.find((candidate) => normalizeAgentId(candidate.id) === agentId);
  if (!entry) {
    entry = { id: agentId };
    entries.push(entry);
  }
  entry.model = withFallbacks(entry.model, fallbacks);
  return next;
}

/**
 * Resolves the fallback chain for the selected key. When an agent id is given
 * and that agent has its own text-model override, its chain is returned
 * (mirroring `openclaw models status --agent <id>`); otherwise the global
 * defaults apply.
 */
function getFallbacks(cfg: OpenClawConfig, key: DefaultsFallbackKey, agentId?: string): string[] {
  if (agentId && key === "model") {
    const override = resolveAgentModelFallbacksOverride(cfg, agentId);
    if (override !== undefined) {
      return override;
    }
  }
  return resolveAgentModelFallbackValues(cfg.agents?.defaults?.[key]);
}

function patchFallbacks(
  cfg: OpenClawConfig,
  params: {
    key: DefaultsFallbackKey;
    agentId?: string;
    fallbacks: string[];
    models?: Record<string, unknown>;
  },
): OpenClawConfig {
  // The canonical model catalog (agents.defaults.models) is always global; only
  // the fallback list itself is scoped per agent.
  const base = params.models
    ? {
        ...cfg,
        agents: {
          ...cfg.agents,
          defaults: {
            ...cfg.agents?.defaults,
            models: params.models as never,
          },
        },
      }
    : cfg;

  if (params.key === "model" && params.agentId) {
    return patchAgentFallbacks(base, params.agentId, params.fallbacks);
  }

  const existing = toAgentModelListLike(base.agents?.defaults?.[params.key]);
  return {
    ...base,
    agents: {
      ...base.agents,
      defaults: {
        ...base.agents?.defaults,
        [params.key]: mergePrimaryFallbackConfig(existing, { fallbacks: params.fallbacks }),
      },
    },
  };
}

/** Lists fallback model refs for the selected key (per agent when `--agent` is set). */
export async function listFallbacksCommand(
  params: { label: string; key: DefaultsFallbackKey },
  opts: { json?: boolean; plain?: boolean } & FallbackScopeOpts,
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const cfg = await loadModelsConfig({ commandName: `models ${params.key} list`, runtime });
  const agentId = resolveKnownAgentId({ cfg, rawAgentId: opts.agent });
  const fallbacks = getFallbacks(cfg, params.key, agentId);

  if (opts.json) {
    writeRuntimeJson(runtime, { fallbacks });
    return;
  }
  if (opts.plain) {
    for (const entry of fallbacks) {
      runtime.log(entry);
    }
    return;
  }

  runtime.log(`${params.label} (${fallbacks.length}):`);
  if (fallbacks.length === 0) {
    runtime.log("- none");
    return;
  }
  for (const entry of fallbacks) {
    runtime.log(`- ${entry}`);
  }
}

/** Adds a fallback model, creating the canonical model entry when needed. */
export async function addFallbackCommand(
  params: {
    label: string;
    key: DefaultsFallbackKey;
    logPrefix: string;
  },
  modelRaw: string,
  opts: FallbackScopeOpts,
  runtime: RuntimeEnv,
) {
  let agentId: string | undefined;
  const updated = await updateConfig((cfg) => {
    agentId = resolveKnownAgentId({ cfg, rawAgentId: opts.agent });
    const resolved = resolveModelTarget({ raw: modelRaw, cfg });
    const nextModels = {
      ...cfg.agents?.defaults?.models,
    } as Record<string, AgentModelEntryConfig>;
    const targetKey = upsertCanonicalModelConfigEntry(nextModels, resolved);
    const existing = getFallbacks(cfg, params.key, agentId);
    const existingKeys = resolveModelKeysFromEntries({ cfg, entries: existing });
    if (existingKeys.includes(targetKey)) {
      return cfg;
    }

    return patchFallbacks(cfg, {
      key: params.key,
      agentId,
      fallbacks: [...existing, targetKey],
      models: nextModels,
    });
  });

  logConfigUpdated(runtime);
  runtime.log(`${params.logPrefix}: ${getFallbacks(updated, params.key, agentId).join(", ")}`);
}

/** Removes a fallback model by resolving aliases to the canonical provider/model key. */
export async function removeFallbackCommand(
  params: {
    label: string;
    key: DefaultsFallbackKey;
    notFoundLabel: string;
    logPrefix: string;
  },
  modelRaw: string,
  opts: FallbackScopeOpts,
  runtime: RuntimeEnv,
) {
  let agentId: string | undefined;
  const updated = await updateConfig((cfg) => {
    agentId = resolveKnownAgentId({ cfg, rawAgentId: opts.agent });
    const resolved = resolveModelTarget({ raw: modelRaw, cfg });
    const targetKey = modelKey(resolved.provider, resolved.model);
    const aliasIndex = buildModelAliasIndex({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    const existing = getFallbacks(cfg, params.key, agentId);
    // Fallback entries may be aliases or provider/model refs. Resolve each entry
    // before comparison so removing an alias removes the canonical target.
    const filtered = existing.filter((entry) => {
      const resolvedEntry = resolveModelRefFromString({
        raw: entry ?? "",
        defaultProvider: DEFAULT_PROVIDER,
        aliasIndex,
      });
      if (!resolvedEntry) {
        return true;
      }
      return modelKey(resolvedEntry.ref.provider, resolvedEntry.ref.model) !== targetKey;
    });

    if (filtered.length === existing.length) {
      throw new Error(
        `${params.notFoundLabel} not found: ${targetKey}. Run ${formatCliCommand(listCommandForFallbackKey(params.key))} to see configured fallbacks.`,
      );
    }

    return patchFallbacks(cfg, { key: params.key, agentId, fallbacks: filtered });
  });

  logConfigUpdated(runtime);
  runtime.log(`${params.logPrefix}: ${getFallbacks(updated, params.key, agentId).join(", ")}`);
}

/** Clears all fallback model refs for the selected key (per agent when `--agent` is set). */
export async function clearFallbacksCommand(
  params: { key: DefaultsFallbackKey; clearedMessage: string },
  opts: FallbackScopeOpts,
  runtime: RuntimeEnv,
) {
  await updateConfig((cfg) => {
    const agentId = resolveKnownAgentId({ cfg, rawAgentId: opts.agent });
    return patchFallbacks(cfg, { key: params.key, agentId, fallbacks: [] });
  });

  logConfigUpdated(runtime);
  runtime.log(params.clearedMessage);
}
