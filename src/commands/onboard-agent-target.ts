// Resolves one concrete agent owner for onboarding auth, model, workspace, and session effects.
import { isDeepStrictEqual } from "node:util";
import {
  listAgentEntries,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveMutableAgentEntry,
  resolveSoleAgentId,
  toAgentEntriesRecord,
} from "../agents/agent-scope-config.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import {
  normalizeAgentModelMapForConfig,
  normalizeAgentModelRefForConfig,
  resolveAgentModelFallbackValues,
  toAgentModelListLike,
} from "../config/model-input.js";
import type { OptionalBootstrapFileName } from "../config/types.agent-defaults.js";
import type { AgentEntryConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { applyPrimaryModel } from "../plugins/provider-model-primary.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { ensureWorkspaceAndSessions } from "./onboard-helpers.js";

export type OnboardingAgentTarget = {
  agentId: string;
  agentDir: string;
  workspaceDir: string;
};

export function resolveOnboardingAgentTarget(
  config: OpenClawConfig,
  explicitAgentId?: string,
): OnboardingAgentTarget {
  const agentId = normalizeAgentId(
    explicitAgentId ?? tryResolveLegacyCompatibilityAgentId(config) ?? resolveSoleAgentId(config),
  );
  return {
    agentId,
    agentDir: resolveAgentDir(config, agentId),
    workspaceDir: resolveAgentWorkspaceDir(config, agentId),
  };
}

/** Resolve the configured System Agent as the owner of onboarding effects. */
export function resolveSystemAgentOnboardingTarget(config: OpenClawConfig): OnboardingAgentTarget {
  return resolveOnboardingAgentTarget(config, config.agents?.defaults?.systemAgent?.agentId);
}

/** Resolve onboarding setup to its existing or pending first-agent owner. */
export function resolveOnboardingSetupTarget(
  config: OpenClawConfig,
  pendingAgent?: { name: string; workspaceDir: string },
): OnboardingAgentTarget {
  if (config.agents?.ownership === "explicit") {
    return resolveSystemAgentOnboardingTarget(config);
  }
  if (pendingAgent) {
    return {
      ...resolveOnboardingAgentTarget(config, pendingAgent.name),
      workspaceDir: pendingAgent.workspaceDir,
    };
  }
  return resolveOnboardingAgentTarget(config);
}

export async function ensureOnboardingAgentWorkspace(
  target: OnboardingAgentTarget,
  runtime: RuntimeEnv,
  options?: {
    skipBootstrap?: boolean;
    skipOptionalBootstrapFiles?: OptionalBootstrapFileName[];
  },
): Promise<{ bootstrapPending: boolean }> {
  try {
    return await ensureWorkspaceAndSessions(target.workspaceDir, runtime, {
      ...options,
      agentId: target.agentId,
    });
  } catch (error) {
    throw new Error(
      `Workspace provisioning for agent "${target.agentId}" at ${shortenHomePath(target.workspaceDir)} failed: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
}

function replaceOnboardingAgentEntry(
  config: OpenClawConfig,
  updated: OpenClawConfig,
  target: OnboardingAgentTarget,
  nextEntry: AgentEntryConfig,
): OpenClawConfig {
  const entries = listAgentEntries(config);
  const index = entries.findIndex((entry) => normalizeAgentId(entry.id) === target.agentId);
  const nextEntries = [...entries];
  const replacement = { id: index >= 0 ? entries[index]!.id : target.agentId, ...nextEntry };
  if (index >= 0) {
    nextEntries[index] = replacement;
  } else {
    nextEntries.push(replacement);
  }
  const { list: _list, entries: _entries, ...agents } = config.agents ?? {};
  return {
    ...updated,
    agents: {
      ...agents,
      entries: toAgentEntriesRecord(nextEntries),
    },
  };
}

export function applyOnboardingWorkspace(
  config: OpenClawConfig,
  target: OnboardingAgentTarget,
  workspace: string,
): OpenClawConfig {
  const entry = resolveMutableAgentEntry(config, target.agentId);
  // Explicit fleets own workspace at the selected entry even when it inherited
  // the global default; legacy owners stay global until they author an override.
  if (entry?.workspace !== undefined || (config.agents?.ownership === "explicit" && entry)) {
    return replaceOnboardingAgentEntry(config, config, target, { ...entry, workspace });
  }
  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: { ...config.agents?.defaults, workspace },
    },
  };
}

export function applyOnboardingPrimaryModel(
  config: OpenClawConfig,
  target: OnboardingAgentTarget,
  model: string,
): OpenClawConfig {
  const entry = resolveMutableAgentEntry(config, target.agentId);
  if (entry?.model === undefined && config.agents?.ownership !== "explicit") {
    return applyPrimaryModel(config, model);
  }

  const primary = normalizeAgentModelRefForConfig(model);
  const fallbackValues = resolveAgentModelFallbackValues(entry?.model).map((fallback) =>
    normalizeAgentModelRefForConfig(fallback),
  );
  const models = normalizeAgentModelMapForConfig(entry?.models ?? {});
  return replaceOnboardingAgentEntry(config, config, target, {
    ...entry,
    model: {
      ...(fallbackValues.length > 0 ? { fallbacks: fallbackValues } : {}),
      primary,
    },
    models: {
      ...models,
      [primary]: models[primary] ?? {},
    },
  });
}

/** Expose one agent's effective model settings through the defaults-based provider contract. */
export function prepareAgentModelDefaults(
  config: OpenClawConfig,
  target: OnboardingAgentTarget,
): OpenClawConfig {
  const entry = resolveMutableAgentEntry(config, target.agentId);
  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        ...(entry?.model !== undefined ? { model: entry.model } : {}),
        ...(entry?.models !== undefined ? { models: entry.models } : {}),
        ...(entry?.modelPolicy !== undefined ? { modelPolicy: entry.modelPolicy } : {}),
      },
    },
  };
}

/** Apply a model-default mutation to one agent without flattening it globally. */
export function applyAgentModelDefaults(
  config: OpenClawConfig,
  target: OnboardingAgentTarget,
  mutate: (config: OpenClawConfig) => OpenClawConfig,
): OpenClawConfig {
  return projectAgentModelDefaults(
    config,
    target,
    mutate(prepareAgentModelDefaults(config, target)),
  );
}

/** Move a defaults-based model mutation onto one agent while preserving its other config changes. */
export function projectAgentModelDefaults(
  config: OpenClawConfig,
  target: OnboardingAgentTarget,
  updated: OpenClawConfig,
): OpenClawConfig {
  const entry = resolveMutableAgentEntry(config, target.agentId);
  if (!entry && config.agents?.ownership !== "explicit") {
    return updated;
  }
  const updatedDefaults = updated.agents?.defaults;
  const originalDefaults = config.agents?.defaults;
  const agentModels =
    entry?.models !== undefined
      ? updatedDefaults?.models
      : Object.fromEntries(
          Object.entries(updatedDefaults?.models ?? {}).filter(
            ([modelRef, model]) =>
              !Object.hasOwn(originalDefaults?.models ?? {}, modelRef) ||
              !isDeepStrictEqual(model, originalDefaults?.models?.[modelRef]),
          ),
        );
  const hasAgentModel =
    entry?.model !== undefined ||
    !isDeepStrictEqual(
      toAgentModelListLike(updatedDefaults?.model),
      toAgentModelListLike(originalDefaults?.model),
    );
  const hasAgentModelPolicy =
    entry?.modelPolicy !== undefined ||
    !isDeepStrictEqual(updatedDefaults?.modelPolicy, originalDefaults?.modelPolicy);
  const { model: _model, models: _models, modelPolicy: _modelPolicy, ...entryRest } = entry ?? {};
  const nextEntry = {
    ...entryRest,
    ...(hasAgentModel && updatedDefaults?.model !== undefined
      ? { model: updatedDefaults.model }
      : {}),
    ...(agentModels && Object.keys(agentModels).length > 0 ? { models: agentModels } : {}),
    ...(hasAgentModelPolicy && updatedDefaults?.modelPolicy !== undefined
      ? { modelPolicy: updatedDefaults.modelPolicy }
      : {}),
  };
  const {
    model: _updatedModel,
    models: _updatedModels,
    modelPolicy: _updatedModelPolicy,
    ...sharedDefaults
  } = updatedDefaults ?? {};
  const baseConfig = {
    ...config,
    agents: {
      ...config.agents,
      ...(originalDefaults || updatedDefaults
        ? {
            defaults: {
              ...sharedDefaults,
              ...(originalDefaults?.model !== undefined ? { model: originalDefaults.model } : {}),
              ...(originalDefaults?.models !== undefined
                ? { models: originalDefaults.models }
                : {}),
              ...(originalDefaults?.modelPolicy !== undefined
                ? { modelPolicy: originalDefaults.modelPolicy }
                : {}),
            },
          }
        : {}),
    },
  };
  return replaceOnboardingAgentEntry(baseConfig, updated, target, nextEntry);
}
