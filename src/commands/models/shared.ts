/** Shared helpers for model commands that read or mutate model config. */

import { resolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { listAgentIds, resolveAgentDir, resolveSoleAgentId } from "../../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import {
  buildModelAliasIndex,
  legacyModelKey,
  modelKey,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { formatCliCommand } from "../../cli/command-format.js";
import {
  type OpenClawConfig,
  readConfigFileSnapshot,
  replaceConfigFile,
} from "../../config/config.js";
import type { ConfigWriteOptions } from "../../config/io.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import { normalizeAgentModelRefForConfig, toAgentModelListLike } from "../../config/model-input.js";
import type { AgentModelEntryConfig } from "../../config/types.agent-defaults.js";
import type { AgentModelConfig } from "../../config/types.agents-shared.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { inspectModelReference } from "./model-reference-validation.js";
import {
  canonicalizeModelCatalogProviderRef,
  createModelCatalogProviderAliasCanonicalizer,
} from "./provider-aliases.js";

export { formatTokenK } from "./list.format.js";
/** Rejects conflicting machine-readable output modes. */
export function ensureFlagCompatibility(opts: { json?: boolean; plain?: boolean }): void {
  if (opts.json && opts.plain) {
    throw new Error("Choose either --json or --plain, not both.");
  }
}

/** Formats millisecond durations for model command output. */
export const formatMs = (value?: number | null) => {
  if (value === null || value === undefined) {
    return "-";
  }
  if (!Number.isFinite(value)) {
    return "-";
  }
  if (value < 1000) {
    return `${Math.round(value)}ms`;
  }
  return `${Math.round(value / 100) / 10}s`;
};

/** Loads config from disk and throws a formatted error when validation fails. */
export async function loadValidConfigOrThrow(): Promise<OpenClawConfig> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    const issues = formatConfigIssueLines(snapshot.issues, "-").join("\n");
    throw new Error(`Invalid config at ${snapshot.path}\n${issues}`);
  }
  return snapshot.runtimeConfig ?? snapshot.config;
}

/** Runtime config snapshot supplied to model config mutators. */
type UpdateConfigContext = {
  runtimeConfig: OpenClawConfig;
};

/** Reads source config, applies a mutator, and writes only the source-form config. */
export async function updateConfig(
  mutator: (
    cfg: OpenClawConfig,
    context: UpdateConfigContext,
  ) => OpenClawConfig | Promise<OpenClawConfig>,
  options: { writeOptions?: ConfigWriteOptions } = {},
): Promise<OpenClawConfig> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    const issues = formatConfigIssueLines(snapshot.issues, "-").join("\n");
    throw new Error(`Invalid config at ${snapshot.path}\n${issues}`);
  }
  const sourceConfig = structuredClone(snapshot.sourceConfig ?? snapshot.config);
  const runtimeConfig = structuredClone(snapshot.runtimeConfig ?? snapshot.config);
  // Mutate source config so SecretRefs and unresolved placeholders do not get
  // overwritten by runtime-resolved secret values.
  const next = await mutator(sourceConfig, { runtimeConfig });
  await replaceConfigFile({
    nextConfig: next,
    baseHash: snapshot.hash,
    ...(options.writeOptions ? { writeOptions: options.writeOptions } : {}),
  });
  return next;
}

/** Resolves a CLI model reference through aliases and catalog provider aliases. */
export function resolveModelTarget(params: { raw: string; cfg: OpenClawConfig }): {
  provider: string;
  model: string;
} {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const resolved = resolveModelRefFromString({
    raw: params.raw,
    defaultProvider: DEFAULT_PROVIDER,
    aliasIndex,
  });
  if (!resolved) {
    throw new Error(`Invalid model reference: ${params.raw}`);
  }
  return canonicalizeModelCatalogProviderRef(resolved.ref, { cfg: params.cfg });
}

function resolveAuthoredModelAliasTarget(params: {
  raw: string;
  cfg: OpenClawConfig;
}): { provider: string; model: string } | undefined {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const resolved = resolveModelRefFromString({
    raw: params.raw,
    defaultProvider: DEFAULT_PROVIDER,
    aliasIndex,
  });
  return resolved?.alias ? resolved.ref : undefined;
}

/** Resolves model reference strings to index-aligned canonical provider/model keys. */
export function resolveModelKeysFromEntries(params: {
  cfg: OpenClawConfig;
  entries: readonly string[];
}): Array<string | undefined> {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const canonicalizer = createModelCatalogProviderAliasCanonicalizer({ cfg: params.cfg });
  return params.entries.map((entry) => {
    const resolved = resolveModelRefFromString({
      raw: entry,
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
    });
    const ref = resolved ? canonicalizer.ref(resolved.ref) : undefined;
    return ref ? modelKey(ref.provider, ref.model) : undefined;
  });
}

function resolveKnownAgentId(cfg: OpenClawConfig, rawAgentId: string): string {
  const agentId = normalizeAgentId(rawAgentId);
  if (!listAgentIds(cfg).includes(agentId)) {
    throw new Error(
      `Unknown agent id "${rawAgentId}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`,
    );
  }
  return agentId;
}

type ModelsTargetMode = { kind: "read"; agentDirOverride?: string } | { kind: "mutation" };

/** Resolves model-command scope and retains configured auth ownership through read overrides. */
export function resolveModelsTargetAgent(
  cfg: OpenClawConfig,
  rawAgentId: string | undefined,
  mode: ModelsTargetMode,
): {
  agentId: string;
  agentDir: string;
} {
  const requested = rawAgentId?.trim();
  if (rawAgentId !== undefined && !requested) {
    throw new Error("--agent must not be blank");
  }
  const requestedAgentId = requested ? resolveKnownAgentId(cfg, requested) : undefined;
  const resolvedAgentId =
    mode.kind === "read"
      ? resolveAmbientOwnerAgentId(cfg, requestedAgentId, {
          surface: "model inspection",
          hint: "Pass --agent <id> or set agents.defaults.systemAgent.agentId.",
        })
      : (requestedAgentId ??
        resolveSoleAgentId(cfg, { surface: "the model command", hint: "Pass --agent <id>." }));
  const agentId = resolveKnownAgentId(cfg, resolvedAgentId);
  const agentDirOverride = mode.kind === "read" ? mode.agentDirOverride : undefined;
  const agentDir = resolveAgentDir(cfg, agentId);
  return { agentId, agentDir: agentDirOverride ?? agentDir };
}

/** Normalized primary/fallback config shape used by text and image defaults. */
type PrimaryFallbackConfig = { primary?: string; fallbacks?: string[] };

/** Upserts the canonical model entry and folds legacy key metadata into it. */
export function upsertCanonicalModelConfigEntry(
  models: Record<string, AgentModelEntryConfig>,
  params: { provider: string; model: string },
) {
  const key = modelKey(params.provider, params.model);
  const legacyKeys = [
    legacyModelKey(params.provider, params.model),
    `${params.provider}/${key}`,
  ].filter(
    (legacyKey): legacyKey is string =>
      typeof legacyKey === "string" && legacyKey.length > 0 && legacyKey !== key,
  );
  let legacyEntry: AgentModelEntryConfig | undefined;
  for (const legacyKey of legacyKeys) {
    const entry = models[legacyKey];
    if (!entry) {
      continue;
    }
    Object.assign((legacyEntry ??= {}), entry);
    legacyEntry.params = {
      ...legacyEntry.params,
      ...entry.params,
    };
  }

  if (legacyEntry) {
    // Preserve legacy per-model params while moving the entry to provider/model.
    models[key] = {
      ...legacyEntry,
      ...models[key],
      params: {
        ...legacyEntry.params,
        ...models[key]?.params,
      },
    };
  } else if (!models[key]) {
    models[key] = {};
  }
  for (const legacyKey of legacyKeys) {
    delete models[legacyKey];
  }
  return key;
}

/** Merges primary/fallback patches while normalizing refs for config storage. */
export function mergePrimaryFallbackConfig(
  existing: PrimaryFallbackConfig | undefined,
  patch: { primary?: string; fallbacks?: string[] },
): PrimaryFallbackConfig {
  const base = existing && typeof existing === "object" ? existing : undefined;
  const next: PrimaryFallbackConfig = { ...base };
  if (patch.primary !== undefined) {
    next.primary = normalizeAgentModelRefForConfig(patch.primary);
  }
  if (patch.fallbacks !== undefined) {
    next.fallbacks = patch.fallbacks.map((fallback) => normalizeAgentModelRefForConfig(fallback));
  } else if (next.fallbacks !== undefined) {
    next.fallbacks = next.fallbacks.map((fallback) => normalizeAgentModelRefForConfig(fallback));
  }
  return next;
}

/** Applies a default text/image primary-model update and ensures the model entry exists. */
export function applyDefaultModelPrimaryUpdate(params: {
  cfg: OpenClawConfig;
  resolveCfg?: OpenClawConfig;
  modelRaw: string;
  field: "model" | "imageModel";
  resolvedTarget?: { provider: string; model: string };
}): OpenClawConfig {
  const resolved = params.resolvedTarget ?? resolveDefaultModelPrimaryTarget(params);
  const nextModels = {
    ...params.cfg.agents?.defaults?.models,
  } as Record<string, AgentModelEntryConfig>;
  const key = upsertCanonicalModelConfigEntry(nextModels, resolved);

  const defaults = params.cfg.agents?.defaults ?? {};
  const existing = toAgentModelListLike(
    (defaults as Record<string, unknown>)[params.field] as AgentModelConfig | undefined,
  );

  return {
    ...params.cfg,
    agents: {
      ...params.cfg.agents,
      defaults: {
        ...defaults,
        [params.field]: mergePrimaryFallbackConfig(existing, { primary: key }),
        models: nextModels,
      },
    },
  };
}

function resolveDefaultModelPrimaryTarget(params: {
  cfg: OpenClawConfig;
  resolveCfg?: OpenClawConfig;
  modelRaw: string;
}): { provider: string; model: string } {
  return params.resolveCfg && params.resolveCfg !== params.cfg
    ? (resolveAuthoredModelAliasTarget({ raw: params.modelRaw, cfg: params.cfg }) ??
        resolveModelTarget({ raw: params.modelRaw, cfg: params.resolveCfg }))
    : resolveModelTarget({ raw: params.modelRaw, cfg: params.cfg });
}

/** Validates and persists one default text/image model selection. */
export async function updateDefaultModelPrimaryConfig(params: {
  modelRaw: string;
  field: "model" | "imageModel";
}): Promise<{ updated: OpenClawConfig; warning?: string }> {
  let warning: string | undefined;
  const updated = await updateConfig((cfg, context) => {
    const resolvedTarget = resolveDefaultModelPrimaryTarget({
      cfg,
      resolveCfg: context.runtimeConfig,
      modelRaw: params.modelRaw,
    });
    const inspection = inspectModelReference({ cfg: context.runtimeConfig, ref: resolvedTarget });
    if (inspection.status === "unknown-provider") {
      throw new Error(
        `Unknown model provider "${inspection.provider}". Install a plugin that declares it or configure it under models.providers before selecting "${inspection.ref}". Config was not changed.`,
      );
    }
    if (inspection.status === "unknown-model") {
      warning = `Warning: Model "${inspection.ref}" is not in the local model catalog for provider "${inspection.provider}". The provider is installed or configured, so the selection was saved; verify the model ID if it is not a newly released or self-hosted model.`;
    }
    return applyDefaultModelPrimaryUpdate({
      cfg,
      resolveCfg: context.runtimeConfig,
      modelRaw: params.modelRaw,
      field: params.field,
      resolvedTarget,
    });
  });
  return { updated, ...(warning ? { warning } : {}) };
}

export { modelKey };
export { DEFAULT_MODEL, DEFAULT_PROVIDER };

/**
 * Model key format: "provider/model"
 *
 * The model key is displayed in `/model status` and used to reference models.
 * When using `/model <key>`, use the exact format shown (e.g., "openrouter/moonshotai/kimi-k2").
 *
 * For providers with hierarchical model IDs (e.g., OpenRouter), the model ID may include
 * sub-providers (e.g., "moonshotai/kimi-k2"), resulting in a key like "openrouter/moonshotai/kimi-k2".
 */
