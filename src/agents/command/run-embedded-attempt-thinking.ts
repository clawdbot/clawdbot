import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ModelCatalogEntry } from "../model-catalog.types.js";
import type { ModelManifestNormalizationContext } from "../model-ref-shared.js";
import { resolveThinkingDefault } from "../model-selection.js";
import { resolveConfiguredThinkingDefault } from "../model-thinking-default.js";
import { createModelVisibilityPolicy } from "../model-visibility-policy.js";
import {
  hasResolvedThinkingCatalogEntry,
  normalizeThinkingCatalogProviders,
  resolveCandidateThinkingLevel,
  resolveEffectiveAgentRuntime,
} from "../thinking-runtime.js";

export function createEmbeddedAttemptCandidateThinkingResolver(params: {
  cfg: OpenClawConfig;
  pluginsEnabled: boolean;
  sessionAgentId: string;
  sessionKey?: string;
  workspaceDir: string;
  modelManifestContext: ModelManifestNormalizationContext;
  defaultProvider: string;
  defaultModel: string;
  immutableThinkLevel?: ThinkLevel;
  initialCatalog?: ModelCatalogEntry[];
}): (candidate: {
  provider: string;
  model: string;
  sessionEntry?: SessionEntry;
}) => Promise<ThinkLevel> {
  let thinkingCatalog = params.initialCatalog;
  let attemptedCatalogHydration = false;

  return async (candidate) => {
    const candidateRuntime = resolveEffectiveAgentRuntime({
      cfg: params.cfg,
      provider: candidate.provider,
      modelId: candidate.model,
      agentId: params.sessionAgentId,
      sessionKey: params.sessionKey,
      sessionEntry: candidate.sessionEntry,
    });
    const configuredThinkLevel =
      params.immutableThinkLevel ??
      resolveConfiguredThinkingDefault({
        cfg: params.cfg,
        provider: candidate.provider,
        model: candidate.model,
      });
    if (
      params.pluginsEnabled &&
      configuredThinkLevel !== "off" &&
      !attemptedCatalogHydration &&
      !hasResolvedThinkingCatalogEntry({
        catalog: thinkingCatalog,
        provider: candidate.provider,
        model: candidate.model,
      })
    ) {
      attemptedCatalogHydration = true;
      const { loadPreparedModelCatalogSnapshot } = await import("../model-catalog.runtime.js");
      const runtimeCatalog = normalizeThinkingCatalogProviders(
        (
          await loadPreparedModelCatalogSnapshot({
            config: params.cfg,
            agentId: params.sessionAgentId,
            workspaceDir: params.workspaceDir,
          })
        ).entries,
      );
      const allowedRuntimeCatalog = createModelVisibilityPolicy({
        cfg: params.cfg,
        catalog: runtimeCatalog,
        defaultProvider: params.defaultProvider,
        defaultModel: params.defaultModel,
        agentId: params.sessionAgentId,
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
        provider: candidate.provider,
        model: candidate.model,
        catalog: thinkingCatalog,
        agentRuntime: candidateRuntime,
      });
    return (
      resolveCandidateThinkingLevel({
        cfg: params.cfg,
        provider: candidate.provider,
        modelId: candidate.model,
        level: requestedThinkLevel,
        catalog: thinkingCatalog,
        agentId: params.sessionAgentId,
        sessionKey: params.sessionKey,
        sessionEntry: candidate.sessionEntry,
        agentRuntime: candidateRuntime,
      }) ?? requestedThinkLevel
    );
  };
}
