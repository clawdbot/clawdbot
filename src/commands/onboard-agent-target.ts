// Resolves one concrete agent owner for onboarding auth, model, workspace, and session effects.
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope-config.js";
import {
  normalizeAgentModelMapForConfig,
  normalizeAgentModelRefForConfig,
  resolveAgentModelFallbackValues,
} from "../config/model-input.js";
import type { OptionalBootstrapFileName } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyPrimaryModel } from "../plugins/provider-model-primary.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
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
  const agentId = normalizeAgentId(explicitAgentId ?? resolveDefaultAgentId(config));
  return {
    agentId,
    agentDir: resolveAgentDir(config, agentId),
    workspaceDir: resolveAgentWorkspaceDir(config, agentId),
  };
}

export async function ensureOnboardingAgentWorkspace(
  target: OnboardingAgentTarget,
  runtime: RuntimeEnv,
  options?: {
    skipBootstrap?: boolean;
    skipOptionalBootstrapFiles?: OptionalBootstrapFileName[];
  },
): Promise<{ bootstrapPending: boolean }> {
  return ensureWorkspaceAndSessions(target.workspaceDir, runtime, {
    ...options,
    agentId: target.agentId,
  });
}

export function applyOnboardingPrimaryModel(
  config: OpenClawConfig,
  target: OnboardingAgentTarget,
  model: string,
): OpenClawConfig {
  const entry = config.agents?.entries?.[target.agentId];
  if (entry?.model === undefined) {
    return applyPrimaryModel(config, model);
  }

  const primary = normalizeAgentModelRefForConfig(model);
  const fallbackValues = resolveAgentModelFallbackValues(entry.model).map((fallback) =>
    normalizeAgentModelRefForConfig(fallback),
  );
  const models = normalizeAgentModelMapForConfig(entry.models ?? {});
  return {
    ...config,
    agents: {
      ...config.agents,
      entries: {
        ...config.agents?.entries,
        [target.agentId]: {
          ...entry,
          model: {
            ...(fallbackValues.length > 0 ? { fallbacks: fallbackValues } : {}),
            primary,
          },
          models: {
            ...models,
            [primary]: models[primary] ?? {},
          },
        },
      },
    },
  };
}
