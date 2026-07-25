import { expectDefined } from "@openclaw/normalization-core";
import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";
import {
  listAgentEntries,
  readAgentRosterProperty,
  toAgentEntriesRecord,
} from "../agents/agent-scope-config.js";
import { normalizeConfiguredProviderCatalogModelId } from "../agents/model-ref-shared.js";
import {
  normalizeAgentModelMapForConfig,
  normalizeAgentModelRefForConfig,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PathSegment } from "./config-cli-path.js";

function normalizeAgentDefaultModelValue(value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeAgentModelRefForConfig(value);
  }
  if (!isPlainRecord(value)) {
    return value;
  }

  const next: Record<string, unknown> = { ...value };
  if (typeof next.primary === "string") {
    next.primary = normalizeAgentModelRefForConfig(next.primary);
  }
  if (Array.isArray(next.fallbacks)) {
    next.fallbacks = next.fallbacks.map((fallback) =>
      typeof fallback === "string" ? normalizeAgentModelRefForConfig(fallback) : fallback,
    );
  }
  return next;
}

function normalizeAgentListModelRefs(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  let mutated = false;
  const next = value.map((agent) => {
    if (!isPlainRecord(agent)) {
      return agent;
    }

    let nextAgent = agent;
    if (Object.hasOwn(agent, "model")) {
      const model = normalizeAgentDefaultModelValue(agent.model);
      if (model !== agent.model) {
        nextAgent = { ...nextAgent, model };
        mutated = true;
      }
    }
    if (isPlainRecord(agent.models)) {
      const models = normalizeAgentModelMapForConfig(agent.models);
      if (models !== agent.models) {
        nextAgent = { ...nextAgent, models };
        mutated = true;
      }
    }
    return nextAgent;
  });

  return mutated ? next : value;
}

function normalizeProviderCatalogModels(provider: string, models: unknown): unknown {
  if (!Array.isArray(models)) {
    return models;
  }

  let mutated = false;
  const next = models.map((model) => {
    if (!isPlainRecord(model) || typeof model.id !== "string") {
      return model;
    }
    const trimmed = model.id.trim();
    if (!trimmed) {
      return model;
    }
    const id = normalizeConfiguredProviderCatalogModelId(provider, trimmed);
    if (id === model.id) {
      return model;
    }
    mutated = true;
    return { ...model, id };
  });

  return mutated ? next : models;
}

function normalizeModelProviderRefs(
  providers: NonNullable<OpenClawConfig["models"]>["providers"] | undefined,
): unknown {
  if (!isPlainRecord(providers)) {
    return providers;
  }

  let mutated = false;
  const nextProviders: Record<string, unknown> = { ...providers };
  for (const [provider, providerConfig] of Object.entries(providers)) {
    if (!isPlainRecord(providerConfig)) {
      continue;
    }
    const models = normalizeProviderCatalogModels(provider, providerConfig.models);
    if (models === providerConfig.models) {
      continue;
    }
    nextProviders[provider] = { ...providerConfig, models };
    mutated = true;
  }

  return mutated ? nextProviders : providers;
}

export function normalizeConfigMutationModelRefs(cfg: OpenClawConfig): OpenClawConfig {
  const defaults = cfg.agents?.defaults;
  const agentList = listAgentEntries(cfg);
  const roster = readAgentRosterProperty(cfg);
  const providers = cfg.models?.providers;
  const normalizedAgentList = normalizeAgentListModelRefs(agentList);
  const normalizedProviders = normalizeModelProviderRefs(providers) as typeof providers | undefined;

  return {
    ...cfg,
    ...(defaults || normalizedAgentList !== agentList
      ? {
          agents: {
            ...cfg.agents,
            ...(defaults
              ? {
                  defaults: {
                    ...defaults,
                    ...(defaults.model !== undefined
                      ? {
                          model: normalizeAgentDefaultModelValue(
                            defaults.model,
                          ) as typeof defaults.model,
                        }
                      : undefined),
                    ...(defaults.models !== undefined
                      ? { models: normalizeAgentModelMapForConfig(defaults.models) }
                      : undefined),
                  },
                }
              : undefined),
            ...(normalizedAgentList !== agentList && roster?.kind === "entries"
              ? { entries: toAgentEntriesRecord(normalizedAgentList as typeof agentList) }
              : normalizedAgentList !== agentList && roster?.kind === "list"
                ? { list: normalizedAgentList as typeof agentList }
                : undefined),
          },
        }
      : undefined),
    ...(normalizedProviders !== providers
      ? { models: { ...cfg.models, providers: normalizedProviders } }
      : undefined),
  };
}

export function normalizeConfigMutationExplicitSetPath(path: PathSegment[]): PathSegment[] {
  if (path.length >= 4 && path[0] === "agents" && path[1] === "defaults" && path[2] === "models") {
    const normalizedModelId = normalizeAgentModelRefForConfig(
      expectDefined(path[3], "path entry at 3"),
    );
    return normalizedModelId === path[3]
      ? path
      : [...path.slice(0, 3), normalizedModelId, ...path.slice(4)];
  }
  return path;
}
