/** Resolves model fallback chains for isolated cron runs and preflight. */
import { resolveModelCandidateChain } from "../../agents/model-fallback-candidates.js";
import type { ModelCandidate } from "../../agents/model-fallback.types.js";
import { resolveAgentModelFallbackValues } from "../../config/model-input.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataRegistryView } from "../../plugins/plugin-metadata-snapshot.types.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { CronJob } from "../types.js";
import {
  resolveEffectiveModelFallbacks,
  resolveSubagentModelFallbacksOverride,
} from "./run-execution.runtime.js";
import { logWarn } from "./run.runtime.js";

const cronModelPreflightRuntimeLoader = createLazyImportLoader(
  () => import("./model-preflight.runtime.js"),
);

/** Resolves cron model fallbacks, giving explicit payload fallbacks precedence over subagent/default policy. */
export function resolveCronFallbacksOverride(params: {
  cfg: OpenClawConfig;
  job: CronJob;
  agentId: string;
  useSubagentFallbacks?: boolean;
  inheritDefaultFallbacksForAgentStringModel?: boolean;
}): string[] | undefined {
  const payload = params.job.payload.kind === "agentTurn" ? params.job.payload : undefined;
  const payloadFallbacks = Array.isArray(payload?.fallbacks) ? payload.fallbacks : undefined;
  const hasCronPayloadModelOverride =
    typeof payload?.model === "string" && payload.model.trim().length > 0;
  if (payloadFallbacks !== undefined) {
    return payloadFallbacks;
  }
  if (params.useSubagentFallbacks === true && !hasCronPayloadModelOverride) {
    // A payload model override owns its full candidate chain; otherwise the
    // selected subagent can contribute its configured fallback policy.
    const subagentFallbacksOverride = resolveSubagentModelFallbacksOverride(
      params.cfg,
      params.agentId,
    );
    if (subagentFallbacksOverride !== undefined) {
      return subagentFallbacksOverride;
    }
  }
  if (!hasCronPayloadModelOverride && params.inheritDefaultFallbacksForAgentStringModel === true) {
    const defaultFallbacks = resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
    if (defaultFallbacks.length > 0) {
      return defaultFallbacks;
    }
  }
  return resolveEffectiveModelFallbacks({
    cfg: params.cfg,
    agentId: params.agentId,
    hasSessionModelOverride: hasCronPayloadModelOverride,
    modelOverrideSource: hasCronPayloadModelOverride ? "auto" : undefined,
  });
}

/** Builds the ordered model candidates used by cron preflight checks. */
export function resolveCronPreflightCandidates(params: {
  cfg: OpenClawConfig;
  job: CronJob;
  agentId: string;
  provider: string;
  model: string;
  workspaceDir: string;
  pluginMetadataSnapshot: PluginMetadataRegistryView;
  useSubagentFallbacks?: boolean;
  inheritDefaultFallbacksForAgentStringModel?: boolean;
}): ModelCandidate[] {
  const fallbacksOverride = resolveCronFallbacksOverride({
    cfg: params.cfg,
    job: params.job,
    agentId: params.agentId,
    useSubagentFallbacks: params.useSubagentFallbacks,
    inheritDefaultFallbacksForAgentStringModel: params.inheritDefaultFallbacksForAgentStringModel,
  });
  return resolveModelCandidateChain({
    cfg: params.cfg,
    agentId: params.agentId,
    provider: params.provider,
    model: params.model,
    workspaceDir: params.workspaceDir,
    pluginMetadataSnapshot: params.pluginMetadataSnapshot,
    manifestPlugins: params.pluginMetadataSnapshot.manifestRegistry.plugins,
    requestedRouteResolution: "resolved",
    fallbacksOverride,
  });
}

/** Selects the reachable candidate and retains only its remaining fallback chain. */
export async function resolveCronPreflight(
  params: Parameters<typeof resolveCronPreflightCandidates>[0],
) {
  const modelPreflightRuntime = await cronModelPreflightRuntimeLoader.load();
  const preflightCandidates = resolveCronPreflightCandidates(params);
  let { provider, model } = params;
  let selectedPreflightCandidate: ModelCandidate | undefined;
  let selectedPreflightCandidateIndex = -1;
  let firstUnavailablePreflight:
    | Awaited<ReturnType<typeof modelPreflightRuntime.preflightCronModelProvider>>
    | undefined;
  for (const [index, candidate] of preflightCandidates.entries()) {
    const candidatePreflight = await modelPreflightRuntime.preflightCronModelProvider({
      cfg: params.cfg,
      provider: candidate.provider,
      model: candidate.model,
    });
    if (candidatePreflight.status === "available") {
      selectedPreflightCandidate = candidate;
      selectedPreflightCandidateIndex = index;
      break;
    }
    firstUnavailablePreflight ??= candidatePreflight;
  }
  if (!selectedPreflightCandidate && firstUnavailablePreflight?.status === "unavailable") {
    return { ok: false as const, reason: firstUnavailablePreflight.reason };
  }
  const modelFallbacksOverride =
    selectedPreflightCandidate &&
    (selectedPreflightCandidate.provider !== provider || selectedPreflightCandidate.model !== model)
      ? preflightCandidates
          .slice(selectedPreflightCandidateIndex + 1)
          .map((candidate) => `${candidate.provider}/${candidate.model}`)
      : undefined;
  // When preflight skips the first local candidate, start at the reachable provider.
  if (selectedPreflightCandidate && modelFallbacksOverride) {
    if (firstUnavailablePreflight?.status === "unavailable") {
      logWarn(
        `[cron:${params.job.id}] ${firstUnavailablePreflight.reason}; continuing with fallback ${selectedPreflightCandidate.provider}/${selectedPreflightCandidate.model}.`,
      );
    }
    provider = selectedPreflightCandidate.provider;
    model = selectedPreflightCandidate.model;
  }
  return {
    ok: true as const,
    provider,
    model,
    modelFallbacksOverride,
    runtimePluginCandidates: preflightCandidates.slice(
      Math.max(0, selectedPreflightCandidateIndex),
    ),
  };
}
