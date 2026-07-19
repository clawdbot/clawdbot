// Doctor-only repair for agent model refs whose provider is no longer available.
import fs from "node:fs";
import path from "node:path";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import { normalizeProviderId } from "../../../agents/model-selection.js";
import type { AgentModelConfig } from "../../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolvePluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.js";

type StaleAgentModelRefRepair = {
  config: OpenClawConfig;
  changes: string[];
  warnings: string[];
};

type RepairOptions = {
  env?: NodeJS.ProcessEnv;
  /** Test seam for the provider ids supplied by bundled or installed plugins. */
  pluginProviderIds?: ReadonlySet<string>;
  /** Test seam for provider ids already present in each agent's models.json. */
  persistedProviderIdsByAgentId?: ReadonlyMap<string, ReadonlySet<string>>;
};

const DEFAULT_MODEL_REF = `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function providerFromModelRef(ref: string): string | undefined {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return undefined;
  }
  const provider = normalizeProviderId(trimmed.slice(0, slash));
  return provider || undefined;
}

function collectPluginProviderIds(
  cfg: OpenClawConfig,
  options: RepairOptions,
): { providerIds?: Set<string>; warnings: string[] } {
  if (options.pluginProviderIds) {
    return {
      providerIds: new Set([...options.pluginProviderIds].map(normalizeProviderId).filter(Boolean)),
      warnings: [],
    };
  }

  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  const snapshot = resolvePluginMetadataSnapshot({
    config: cfg,
    workspaceDir: workspaceDir ?? undefined,
    env: options.env ?? process.env,
    allowWorkspaceScopedCurrent: true,
  });
  if (snapshot.diagnostics.some((diagnostic) => diagnostic.level === "error")) {
    return {
      warnings: [
        "Skipped stale agent model reference repair because plugin discovery reported errors.",
      ],
    };
  }

  const providerIds = new Set<string>();
  for (const owners of [
    snapshot.owners.providers,
    snapshot.owners.modelCatalogProviders,
    snapshot.owners.setupProviders,
    snapshot.owners.cliBackends,
  ]) {
    for (const providerId of owners.keys()) {
      const normalized = normalizeProviderId(providerId);
      if (normalized) {
        providerIds.add(normalized);
      }
    }
  }
  return { providerIds, warnings: [] };
}

function collectPersistedProviderIds(params: {
  cfg: OpenClawConfig;
  agentId: string;
  env: NodeJS.ProcessEnv;
  injected?: ReadonlyMap<string, ReadonlySet<string>>;
}): { providerIds?: Set<string>; warning?: string } {
  const injected = params.injected?.get(params.agentId);
  if (injected) {
    return {
      providerIds: new Set([...injected].map(normalizeProviderId).filter(Boolean)),
    };
  }
  if (params.injected) {
    return { providerIds: new Set() };
  }

  const modelsPath = path.join(
    resolveAgentDir(params.cfg, params.agentId, params.env),
    "models.json",
  );
  let raw: string;
  try {
    raw = fs.readFileSync(modelsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { providerIds: new Set() };
    }
    return {
      warning: `Skipped stale model reference repair for agent "${params.agentId}" because ${modelsPath} could not be read.`,
    };
  }
  try {
    const parsed = JSON.parse(raw) as { providers?: unknown };
    if (
      !parsed.providers ||
      typeof parsed.providers !== "object" ||
      Array.isArray(parsed.providers)
    ) {
      return { providerIds: new Set() };
    }
    return {
      providerIds: new Set(Object.keys(parsed.providers).map(normalizeProviderId).filter(Boolean)),
    };
  } catch {
    return {
      warning: `Skipped stale model reference repair for agent "${params.agentId}" because ${modelsPath} is invalid JSON.`,
    };
  }
}

function repairModelMap(params: {
  models: Record<string, unknown> | undefined;
  path: string;
  isStale: (ref: string) => string | undefined;
  replacementRef?: string;
  ensureReplacement?: boolean;
  changes: string[];
  warnings: string[];
}): void {
  if (!isRecord(params.models)) {
    return;
  }
  const refs = Object.keys(params.models);
  const staleRefs = refs.filter((ref) => params.isStale(ref));
  if (staleRefs.length === refs.length && staleRefs.length > 0 && !params.replacementRef) {
    params.warnings.push(
      `Skipped clearing ${params.path} because no available replacement model could keep the allowlist restrictive.`,
    );
    return;
  }
  for (const ref of staleRefs) {
    const provider = params.isStale(ref);
    delete params.models[ref];
    params.changes.push(
      `Removed stale ${params.path} entry "${ref}" (provider "${provider}" is unavailable).`,
    );
  }
  if (
    refs.length > 0 &&
    (staleRefs.length > 0 || params.ensureReplacement === true) &&
    params.replacementRef &&
    !Object.hasOwn(params.models, params.replacementRef)
  ) {
    params.models[params.replacementRef] = {};
    params.changes.push(
      `Added ${params.path} entry "${params.replacementRef}" to keep the repaired allowlist restrictive.`,
    );
  }
}

function filterFallbacks(params: {
  model: Exclude<AgentModelConfig, string>;
  path: string;
  isStale: (ref: string) => string | undefined;
  changes: string[];
}): void {
  if (!Array.isArray(params.model.fallbacks)) {
    return;
  }
  params.model.fallbacks = params.model.fallbacks.filter((ref) => {
    if (typeof ref !== "string") {
      return true;
    }
    const provider = params.isStale(ref);
    if (!provider) {
      return true;
    }
    params.changes.push(
      `Removed stale ${params.path} fallback "${ref}" (provider "${provider}" is unavailable).`,
    );
    return false;
  });
  if (params.model.fallbacks.length === 0) {
    delete params.model.fallbacks;
  }
}

function firstExplicitModelRef(cfg: OpenClawConfig): string | undefined {
  if (!isRecord(cfg.models?.providers)) {
    return undefined;
  }
  for (const [providerId, provider] of Object.entries(cfg.models.providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) {
      continue;
    }
    const normalizedProvider = normalizeProviderId(providerId);
    const modelId = provider.models
      .map((model) => (isRecord(model) && typeof model.id === "string" ? model.id.trim() : ""))
      .find(Boolean);
    if (normalizedProvider && modelId) {
      return `${normalizedProvider}/${modelId}`;
    }
  }
  return undefined;
}

function modelPrimaryRef(model: unknown): string | undefined {
  if (typeof model === "string") {
    return model;
  }
  return isRecord(model) && typeof model.primary === "string" ? model.primary : undefined;
}

export function repairStaleAgentModelRefs(
  cfg: OpenClawConfig,
  options: RepairOptions = {},
): StaleAgentModelRefRepair {
  const replaceMode = cfg.models?.mode === "replace";
  const pluginProviders = replaceMode
    ? { providerIds: new Set<string>(), warnings: [] }
    : collectPluginProviderIds(cfg, options);
  if (!pluginProviders.providerIds) {
    return { config: cfg, changes: [], warnings: pluginProviders.warnings };
  }

  // Bundled core providers declare provider ownership in their plugin manifests,
  // so the metadata snapshot is the canonical inventory for both core and plugins.
  const baseAvailableProviders = pluginProviders.providerIds;
  if (!replaceMode) {
    baseAvailableProviders.add(normalizeProviderId(DEFAULT_PROVIDER));
  }
  for (const providerId of Object.keys(cfg.models?.providers ?? {})) {
    const normalized = normalizeProviderId(providerId);
    if (normalized) {
      baseAvailableProviders.add(normalized);
    }
  }
  for (const backendId of Object.keys(
    isRecord(cfg.agents?.defaults?.cliBackends) ? cfg.agents.defaults.cliBackends : {},
  )) {
    const normalized = normalizeProviderId(backendId);
    if (normalized) {
      baseAvailableProviders.add(normalized);
    }
  }

  const config = structuredClone(cfg);
  const changes: string[] = [];
  const warnings = [...pluginProviders.warnings];
  const env = options.env ?? process.env;
  const persistedForAgent = (agentId: string): Set<string> | undefined => {
    const persisted = collectPersistedProviderIds({
      cfg,
      agentId,
      env,
      injected: options.persistedProviderIdsByAgentId,
    });
    if (!persisted.providerIds) {
      if (persisted.warning) {
        warnings.push(persisted.warning);
      }
      return undefined;
    }
    return persisted.providerIds;
  };
  const availabilityForAgent = (agentId: string): Set<string> | undefined => {
    const available = new Set(baseAvailableProviders);
    if (replaceMode) {
      return available;
    }
    const persisted = persistedForAgent(agentId);
    if (!persisted) {
      return undefined;
    }
    for (const providerId of persisted) {
      available.add(providerId);
    }
    return available;
  };
  const availabilityForDefaults = (): Set<string> | undefined => {
    const available = new Set(baseAvailableProviders);
    if (replaceMode) {
      return available;
    }
    const inheritingAgentIds: string[] = [];
    for (const agent of Array.isArray(cfg.agents?.list) ? cfg.agents.list : []) {
      if (!isRecord(agent) || typeof agent.id !== "string") {
        continue;
      }
      const explicitPrimary = modelPrimaryRef(agent.model);
      if (!explicitPrimary) {
        inheritingAgentIds.push(agent.id);
        continue;
      }
      const agentAvailability = availabilityForAgent(agent.id);
      const provider = providerFromModelRef(explicitPrimary);
      if (agentAvailability && provider && !agentAvailability.has(provider)) {
        // This stale override will be removed or replaced later in the same repair.
        inheritingAgentIds.push(agent.id);
      }
    }
    if (inheritingAgentIds.length === 0) {
      inheritingAgentIds.push(resolveDefaultAgentId(cfg));
    }
    let commonPersisted: Set<string> | undefined;
    for (const agentId of inheritingAgentIds) {
      const persisted = persistedForAgent(agentId);
      if (!persisted) {
        return undefined;
      }
      commonPersisted = commonPersisted
        ? new Set([...commonPersisted].filter((providerId) => persisted.has(providerId)))
        : new Set(persisted);
    }
    for (const providerId of commonPersisted ?? []) {
      available.add(providerId);
    }
    return available;
  };
  const availabilityForDefaultModelMap = (): Set<string> | undefined => {
    const available = new Set(baseAvailableProviders);
    if (replaceMode) {
      return available;
    }
    const inheritingAgentIds = (Array.isArray(cfg.agents?.list) ? cfg.agents.list : [])
      .filter((agent) => isRecord(agent) && typeof agent.id === "string" && !isRecord(agent.models))
      .map((agent) => agent.id as string);
    if (inheritingAgentIds.length === 0) {
      inheritingAgentIds.push(resolveDefaultAgentId(cfg));
    }
    for (const agentId of inheritingAgentIds) {
      const persisted = persistedForAgent(agentId);
      if (!persisted) {
        return undefined;
      }
      for (const providerId of persisted) {
        available.add(providerId);
      }
    }
    return available;
  };
  const makeStaleChecker = (available: ReadonlySet<string>) => (ref: string) => {
    const provider = providerFromModelRef(ref);
    return provider && !available.has(provider) ? provider : undefined;
  };

  const defaults = config.agents?.defaults;
  const defaultAvailability = availabilityForDefaults();
  const configuredDefaultPrimary = modelPrimaryRef(defaults?.model);
  let repairedDefaultPrimary =
    configuredDefaultPrimary ?? (replaceMode ? firstExplicitModelRef(cfg) : DEFAULT_MODEL_REF);
  let defaultPrimaryChanged = false;
  if (defaults && defaultAvailability) {
    const isStale = makeStaleChecker(defaultAvailability);
    const configuredReplacement = replaceMode ? firstExplicitModelRef(cfg) : DEFAULT_MODEL_REF;
    if (defaults.model) {
      if (typeof defaults.model === "string") {
        const provider = isStale(defaults.model);
        if (provider) {
          const staleRef = defaults.model;
          if (configuredReplacement) {
            defaults.model = configuredReplacement;
            defaultPrimaryChanged = true;
            changes.push(
              `Replaced stale agents.defaults.model "${staleRef}" with default "${configuredReplacement}" (provider "${provider}" is unavailable).`,
            );
          } else {
            delete defaults.model;
            defaultPrimaryChanged = true;
            changes.push(
              `Removed stale agents.defaults.model "${staleRef}" because provider "${provider}" is unavailable and no replacement model is configured.`,
            );
          }
        }
      } else if (isRecord(defaults.model)) {
        const provider =
          typeof defaults.model.primary === "string" ? isStale(defaults.model.primary) : undefined;
        let replacement: string | undefined;
        if (provider && typeof defaults.model.primary === "string") {
          const staleRef = defaults.model.primary;
          replacement = replaceMode
            ? ((Array.isArray(defaults.model.fallbacks)
                ? defaults.model.fallbacks.find(
                    (fallback) => typeof fallback === "string" && !isStale(fallback),
                  )
                : undefined) ?? configuredReplacement)
            : configuredReplacement;
          if (replacement) {
            defaults.model.primary = replacement;
            defaultPrimaryChanged = true;
            changes.push(
              `Replaced stale agents.defaults.model primary "${staleRef}" with default "${replacement}" (provider "${provider}" is unavailable).`,
            );
          } else {
            delete defaults.model.primary;
            defaultPrimaryChanged = true;
            changes.push(
              `Removed stale agents.defaults.model primary "${staleRef}" because provider "${provider}" is unavailable and no replacement model is configured.`,
            );
          }
        }
        filterFallbacks({
          model: defaults.model,
          path: "agents.defaults.model",
          isStale,
          changes,
        });
        if (
          replacement &&
          Array.isArray(defaults.model.fallbacks) &&
          defaults.model.fallbacks.includes(replacement)
        ) {
          defaults.model.fallbacks = defaults.model.fallbacks.filter(
            (fallback) => fallback !== replacement,
          );
          changes.push(
            `Removed duplicate agents.defaults.model fallback "${replacement}" after selecting it as the default primary.`,
          );
          if (defaults.model.fallbacks.length === 0) {
            delete defaults.model.fallbacks;
          }
        }
        if (!defaults.model.primary && !defaults.model.fallbacks) {
          delete defaults.model;
        }
      }
    }
    repairedDefaultPrimary =
      modelPrimaryRef(defaults.model) ??
      (replaceMode ? firstExplicitModelRef(cfg) : DEFAULT_MODEL_REF);
    const modelMapAvailability = availabilityForDefaultModelMap();
    if (modelMapAvailability) {
      repairModelMap({
        models: defaults.models,
        path: "agents.defaults.models",
        isStale: makeStaleChecker(modelMapAvailability),
        replacementRef: repairedDefaultPrimary,
        ensureReplacement: defaultPrimaryChanged,
        changes,
        warnings,
      });
    }
  }

  for (const [index, agent] of (Array.isArray(config.agents?.list)
    ? config.agents.list
    : []
  ).entries()) {
    if (!isRecord(agent) || typeof agent.id !== "string") {
      continue;
    }
    const available = availabilityForAgent(agent.id);
    if (!available) {
      continue;
    }
    const isStale = makeStaleChecker(available);
    const modelPath = `agents.list[${index}].model`;
    const inheritedDefaultAvailable = Boolean(
      defaultAvailability &&
      repairedDefaultPrimary &&
      (!replaceMode || modelPrimaryRef(defaults?.model)) &&
      !isStale(repairedDefaultPrimary),
    );
    const canInheritDefault = inheritedDefaultAvailable;
    let agentPrimaryChanged = false;
    if (typeof agent.model === "string") {
      const provider = isStale(agent.model);
      if (provider) {
        const staleRef = agent.model;
        if (canInheritDefault) {
          delete agent.model;
          agentPrimaryChanged = true;
          changes.push(
            `Removed stale ${modelPath} "${staleRef}" so agent "${agent.id}" inherits the default model (provider "${provider}" is unavailable).`,
          );
        } else if (repairedDefaultPrimary && !isStale(repairedDefaultPrimary)) {
          agent.model = repairedDefaultPrimary;
          agentPrimaryChanged = true;
          changes.push(
            `Replaced stale ${modelPath} "${staleRef}" with "${repairedDefaultPrimary}" (provider "${provider}" is unavailable).`,
          );
        } else {
          warnings.push(
            `Skipped stale ${modelPath} repair because no available inherited or replacement model is configured.`,
          );
        }
      }
    } else if (isRecord(agent.model)) {
      const provider =
        typeof agent.model.primary === "string" ? isStale(agent.model.primary) : undefined;
      let agentReplacement: string | undefined;
      if (provider && typeof agent.model.primary === "string") {
        const staleRef = agent.model.primary;
        if (canInheritDefault) {
          delete agent.model.primary;
          agentPrimaryChanged = true;
          agentReplacement = repairedDefaultPrimary;
          changes.push(
            `Removed stale ${modelPath} primary "${staleRef}" so agent "${agent.id}" inherits the default model (provider "${provider}" is unavailable).`,
          );
        } else if (
          (agentReplacement =
            (Array.isArray(agent.model.fallbacks)
              ? agent.model.fallbacks.find(
                  (fallback) => typeof fallback === "string" && !isStale(fallback),
                )
              : undefined) ??
            (repairedDefaultPrimary && !isStale(repairedDefaultPrimary)
              ? repairedDefaultPrimary
              : undefined))
        ) {
          agent.model.primary = agentReplacement;
          agentPrimaryChanged = true;
          changes.push(
            `Replaced stale ${modelPath} primary "${staleRef}" with "${agentReplacement}" (provider "${provider}" is unavailable).`,
          );
        } else {
          warnings.push(
            `Skipped stale ${modelPath} primary repair because no available inherited or replacement model is configured.`,
          );
        }
      }
      filterFallbacks({ model: agent.model, path: modelPath, isStale, changes });
      if (
        agentReplacement &&
        Array.isArray(agent.model.fallbacks) &&
        agent.model.fallbacks.includes(agentReplacement)
      ) {
        agent.model.fallbacks = agent.model.fallbacks.filter(
          (fallback) => fallback !== agentReplacement,
        );
        changes.push(
          `Removed duplicate ${modelPath} fallback "${agentReplacement}" after selecting it as the primary.`,
        );
        if (agent.model.fallbacks.length === 0) {
          delete agent.model.fallbacks;
        }
      }
      if (!agent.model.primary && !agent.model.fallbacks) {
        delete agent.model;
      }
    }
    const effectiveAgentPrimary = modelPrimaryRef(agent.model) ?? repairedDefaultPrimary;
    repairModelMap({
      models: agent.models,
      path: `agents.list[${index}].models`,
      isStale,
      replacementRef:
        effectiveAgentPrimary && !isStale(effectiveAgentPrimary)
          ? effectiveAgentPrimary
          : undefined,
      ensureReplacement:
        agentPrimaryChanged || (!modelPrimaryRef(agent.model) && defaultPrimaryChanged),
      changes,
      warnings,
    });
  }

  return { config: changes.length > 0 ? config : cfg, changes, warnings };
}
