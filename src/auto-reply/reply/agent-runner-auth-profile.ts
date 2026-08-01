// Resolves auth profile settings that agent runner forwards to providers.
import {
  resolveProviderIdForAuth,
  type ProviderAuthAliasLookupParams,
} from "../../agents/provider-auth-aliases.js";
import type { FollowupRun } from "./queue.js";

/** Keeps an auth profile only when the current provider shares the primary auth scope. */
export function resolveProviderScopedAuthProfile(params: {
  provider: string;
  primaryProvider: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  config?: ProviderAuthAliasLookupParams["config"];
  workspaceDir?: ProviderAuthAliasLookupParams["workspaceDir"];
}): { authProfileId?: string; authProfileIdSource?: "auto" | "user" } {
  const aliasParams = { config: params.config, workspaceDir: params.workspaceDir };
  const authProfileId =
    resolveProviderIdForAuth(params.provider, aliasParams) ===
    resolveProviderIdForAuth(params.primaryProvider, aliasParams)
      ? params.authProfileId
      : undefined;
  return {
    authProfileId,
    authProfileIdSource: authProfileId ? params.authProfileIdSource : undefined,
  };
}

/** Resolves the auth profile override for a queued follow-up run. */
export function resolveRunAuthProfile(
  run: FollowupRun["run"],
  provider: string,
  params?: { config?: ProviderAuthAliasLookupParams["config"] },
) {
  return resolveProviderScopedAuthProfile({
    provider,
    primaryProvider: run.provider,
    authProfileId: run.authProfileId,
    authProfileIdSource: run.authProfileIdSource,
    config: params?.config ?? run.config,
    workspaceDir: run.workspaceDir,
  });
}

/** Applies an auto-fallback probe's pinned auth to its fallback candidate. */
export function resolveFallbackCandidateRun(
  run: FollowupRun["run"],
  provider: string,
  model: string,
): FollowupRun["run"] {
  const probe = run.autoFallbackPrimaryProbe;
  const isPrimaryProbeCandidate = probe && provider === probe.provider && model === probe.model;
  if (
    !probe ||
    provider !== probe.fallbackProvider ||
    isPrimaryProbeCandidate ||
    !probe.fallbackAuthProfileId
  ) {
    return run;
  }
  const candidateRun: FollowupRun["run"] = {
    ...run,
    provider,
    model,
    authProfileId: probe.fallbackAuthProfileId,
  };
  if (probe.fallbackAuthProfileIdSource) {
    candidateRun.authProfileIdSource = probe.fallbackAuthProfileIdSource;
  } else {
    delete candidateRun.authProfileIdSource;
  }
  return candidateRun;
}
