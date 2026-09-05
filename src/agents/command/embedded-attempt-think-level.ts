import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ModelCatalogEntry } from "../model-catalog.types.js";
import type { ModelManifestNormalizationContext } from "../model-ref-shared.js";
import { resolveThinkingDefault } from "../model-selection.js";
import { resolveConfiguredThinkingDefault } from "../model-thinking-default.js";
import { createModelVisibilityPolicy } from "../model-visibility-policy.js";
import {
  needsThinkHydration,
  normalizeThinkingCatalogProviders,
  resolveCandidateThinkingLevel,
  resolveEffectiveAgentRuntime,
} from "../thinking-runtime.js";

export type EmbeddedAttemptThinkLevel = {
  agentRuntime: string;
  thinkLevel: ThinkLevel;
  thinkingCatalog: ModelCatalogEntry[] | undefined;
};

/** Resolve per-candidate runtime and thinking so fallbacks do not reuse a frozen primary catalog. */
export async function resolveEmbeddedAttemptThinkLevel(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  agentId: string;
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  workspaceDir: string;
  pluginsEnabled: boolean;
  thinkingCatalog: ModelCatalogEntry[] | undefined;
  immutableThinkLevel?: ThinkLevel;
  defaultProvider: string;
  defaultModel: string;
  modelManifestContext: ModelManifestNormalizationContext;
}): Promise<EmbeddedAttemptThinkLevel> {
  const agentRuntime = resolveEffectiveAgentRuntime({
    cfg: params.cfg,
    provider: params.provider,
    modelId: params.model,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
  });
  const configuredThinkLevel =
    params.immutableThinkLevel ??
    resolveConfiguredThinkingDefault({
      cfg: params.cfg,
      provider: params.provider,
      model: params.model,
    });
  let thinkingCatalog = params.thinkingCatalog;
  if (
    params.pluginsEnabled &&
    configuredThinkLevel !== "off" &&
    needsThinkHydration(params.thinkingCatalog, params.provider, params.model, agentRuntime)
  ) {
    const { loadProviderScopedThinkingCatalog } = await import("../model-catalog.runtime.js");
    const runtimeCatalog = normalizeThinkingCatalogProviders(
      await loadProviderScopedThinkingCatalog({
        config: params.cfg,
        provider: params.provider,
        model: params.model,
        agentId: params.agentId,
        workspaceDir: params.workspaceDir,
      }),
    );
    const allowedRuntimeCatalog = createModelVisibilityPolicy({
      cfg: params.cfg,
      catalog: runtimeCatalog,
      defaultProvider: params.defaultProvider,
      defaultModel: params.defaultModel,
      agentId: params.agentId,
      allowManifestNormalization: true,
      allowPluginNormalization: true,
      ...params.modelManifestContext,
    }).allowedCatalog;
    if (allowedRuntimeCatalog.length > 0) {
      thinkingCatalog = allowedRuntimeCatalog;
    }
  }
  const requestedThinkLevel =
    configuredThinkLevel ??
    resolveThinkingDefault({
      cfg: params.cfg,
      provider: params.provider,
      model: params.model,
      catalog: thinkingCatalog,
      agentRuntime,
    });
  return {
    agentRuntime,
    thinkLevel:
      resolveCandidateThinkingLevel({
        cfg: params.cfg,
        provider: params.provider,
        modelId: params.model,
        level: requestedThinkLevel,
        catalog: thinkingCatalog,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionEntry: params.sessionEntry,
        agentRuntime,
      }) ?? requestedThinkLevel,
    thinkingCatalog,
  };
}
