/** Shared helpers for model commands that read or mutate model config. */

import { expectDefined } from "@openclaw/normalization-core";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { listAgentIds, resolveAgentDir, resolveSoleAgentId } from "../../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import {
  buildModelAliasIndex,
  legacyModelKey,
  modelKey,
  resolveModelRefFromString,
  type ModelRef,
} from "../../agents/model-selection.js";
import { formatCliCommand } from "../../cli/command-format.js";
import {
  type OpenClawConfig,
  readConfigFileSnapshot,
  transformConfigFile,
} from "../../config/config.js";
import { restoreEnvVarRefs } from "../../config/env-preserve.js";
import { resolveConfigIncludes } from "../../config/includes.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import {
  mergeAgentModelEntryForConfig,
  normalizeAgentModelRefForConfig,
  toAgentModelListLike,
} from "../../config/model-input.js";
import { resolveIncludeRoots } from "../../config/paths.js";
import type { AgentModelEntryConfig } from "../../config/types.agent-defaults.js";
import type { AgentModelConfig } from "../../config/types.agents-shared.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { inspectModelReference } from "./model-reference-validation.js";
import {
  canonicalizeModelCatalogProviderRef,
  createModelCatalogProviderAliasCanonicalizer,
} from "./provider-aliases.js";

export { formatTokenK } from "./list.format.js";
export { ensureFlagCompatibility } from "./list.options.js";

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
  canonicalModelKeys?: ReadonlyMap<string, string | undefined>;
  restoreSourceEntry: (
    from: string,
    to: string,
    entry: AgentModelEntryConfig,
  ) => AgentModelEntryConfig;
};

type ModelEntryMergeOptions = Partial<
  Pick<UpdateConfigContext, "canonicalModelKeys" | "restoreSourceEntry">
>;

/** Reads source config, applies a mutator, and writes only the source-form config. */
export async function updateConfig(
  mutator: (
    cfg: OpenClawConfig,
    context: UpdateConfigContext,
  ) => OpenClawConfig | Promise<OpenClawConfig>,
  selectModelRefs?: (
    cfg: OpenClawConfig,
    context: UpdateConfigContext,
  ) => readonly (ModelRef | undefined)[],
): Promise<OpenClawConfig> {
  const explicitSetPaths: string[][] = [];
  const result = await transformConfigFile({
    base: "source",
    writeOptions: { explicitSetPaths },
    transform: async (currentConfig, { snapshot }, { envSnapshotForRestore }) => {
      if (!snapshot.valid) {
        const issues = formatConfigIssueLines(snapshot.issues, "-").join("\n");
        throw new Error(`Invalid config at ${snapshot.path}\n${issues}`);
      }
      const sourceConfig = structuredClone(currentConfig);
      let authoredModels: Record<string, unknown> | undefined;
      const context: UpdateConfigContext = {
        runtimeConfig: snapshot.runtimeConfig,
        restoreSourceEntry: (from, to, entry) => {
          // Equal runtime values can still move an authored key; record that write intent.
          explicitSetPaths.push(["agents", "defaults", "models", to]);
          if (!authoredModels) {
            const authored = asNonArrayRecord(
              resolveConfigIncludes(snapshot.parsed, snapshot.path, undefined, {
                allowedRoots: resolveIncludeRoots(envSnapshotForRestore),
              }),
            );
            const defaults = asNonArrayRecord(asNonArrayRecord(authored.agents).defaults);
            authoredModels = asNonArrayRecord(defaults.models);
          }
          // Source snapshots expand env values; restore while the authored key is known.
          const restored = restoreEnvVarRefs(entry, authoredModels[from], envSnapshotForRestore);
          // SAFETY: Only string leaves change; the validated entry shape remains intact.
          return restored as AgentModelEntryConfig;
        },
      };
      const mutate = () => {
        if (selectModelRefs) {
          const cfg = context.runtimeConfig;
          const canonicalizer = createModelCatalogProviderAliasCanonicalizer({ cfg });
          context.canonicalModelKeys = new Map(
            Object.keys(sourceConfig.agents?.defaults?.models ?? {}).map((key) => {
              // Stored keys are refs, not user-facing aliases. Resolve them only
              // after the command's provider generation has been prepared.
              const resolved = resolveModelRefFromString({
                cfg,
                raw: key,
                defaultProvider: DEFAULT_PROVIDER,
              });
              const ref = resolved && canonicalizer.ref(resolved.ref);
              return [key, ref ? modelKey(ref.provider, ref.model) : undefined];
            }),
          );
        }
        return mutator(sourceConfig, context);
      };
      const nextConfig = selectModelRefs
        ? await (
            await import("./model-selection.runtime.js")
          ).withModelCommandProviderRuntime(
            {
              runtimeConfig: context.runtimeConfig,
              selectModelRefs: () => selectModelRefs(sourceConfig, context),
            },
            mutate,
          )
        : await mutate();
      // The public SDK returns the mutator's value; persisted readback may restore env refs.
      return { nextConfig, result: nextConfig };
    },
  });
  return expectDefined(result.result, "model config mutation result");
}

function resolveModelInput(params: { raw: string; cfg: OpenClawConfig }) {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  return resolveModelRefFromString({
    cfg: params.cfg,
    raw: params.raw,
    defaultProvider: DEFAULT_PROVIDER,
    aliasIndex,
  });
}

/** Resolves a CLI model reference through aliases and catalog provider aliases. */
export function resolveModelTarget(params: { raw: string; cfg: OpenClawConfig }): {
  provider: string;
  model: string;
} {
  const resolved = resolveModelInput(params);
  if (!resolved) {
    throw new Error(`Invalid model reference: ${params.raw}`);
  }
  return canonicalizeModelCatalogProviderRef(resolved.ref, { cfg: params.cfg });
}

function resolveAuthoredModelAliasTarget(params: {
  raw: string;
  cfg: OpenClawConfig;
}): { provider: string; model: string } | undefined {
  const resolved = resolveModelInput(params);
  return resolved?.alias ? resolved.ref : undefined;
}

/** Resolves model reference strings to index-aligned canonical refs. */
export function resolveModelRefsFromEntries(params: {
  cfg: OpenClawConfig;
  entries: readonly string[];
}): Array<ModelRef | undefined> {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const canonicalizer = createModelCatalogProviderAliasCanonicalizer({ cfg: params.cfg });
  return params.entries.map((entry) => {
    const resolved = resolveModelRefFromString({
      cfg: params.cfg,
      raw: entry,
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
    });
    return resolved ? canonicalizer.ref(resolved.ref) : undefined;
  });
}

/** Projects canonical model refs into index-aligned keys for config comparisons. */
export function resolveModelKeysFromEntries(
  params: Parameters<typeof resolveModelRefsFromEntries>[0],
): Array<string | undefined> {
  return resolveModelRefsFromEntries(params).map((ref) =>
    ref ? modelKey(ref.provider, ref.model) : undefined,
  );
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
  options: ModelEntryMergeOptions = {},
) {
  const key = modelKey(params.provider, params.model);
  const { canonicalModelKeys } = options;
  // Prepared ownership facts replace legacy guesses, including an empty selection.
  const sourceKeys = canonicalModelKeys
    ? Object.keys(models).filter((sourceKey) => canonicalModelKeys.get(sourceKey) === key)
    : [legacyModelKey(params.provider, params.model), `${params.provider}/${key}`];
  const legacyKeys = new Set(
    sourceKeys.filter(
      (legacyKey): legacyKey is string =>
        typeof legacyKey === "string" && legacyKey.length > 0 && legacyKey !== key,
    ),
  );
  let legacyEntry: AgentModelEntryConfig | undefined;
  for (const legacyKey of legacyKeys) {
    const entry = models[legacyKey];
    if (!entry) {
      continue;
    }
    legacyEntry = mergeAgentModelEntryForConfig(
      legacyEntry,
      options.restoreSourceEntry ? options.restoreSourceEntry(legacyKey, key, entry) : entry,
    );
  }

  // Canonical values override migrated fields while omitted settings survive.
  models[key] = mergeAgentModelEntryForConfig(legacyEntry, models[key] ?? {});
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
  modelEntryMerge?: ModelEntryMergeOptions;
}): OpenClawConfig {
  const resolved = params.resolvedTarget ?? resolveDefaultModelPrimaryTarget(params);
  const nextModels = {
    ...params.cfg.agents?.defaults?.models,
  } as Record<string, AgentModelEntryConfig>;
  const key = upsertCanonicalModelConfigEntry(nextModels, resolved, params.modelEntryMerge);

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
  const updated = await updateConfig(
    (cfg, context) => {
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
        modelEntryMerge: context,
        modelRaw: params.modelRaw,
        field: params.field,
        resolvedTarget,
      });
    },
    (cfg, context) => [
      resolveDefaultModelPrimaryTarget({
        cfg,
        resolveCfg: context.runtimeConfig,
        modelRaw: params.modelRaw,
      }),
    ],
  );
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
