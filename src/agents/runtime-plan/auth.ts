import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizePluginsConfig } from "../../plugins/config-state.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import {
  type ProviderAuthAliasLookupParams,
  resolveProviderIdForAuth,
} from "../provider-auth-aliases.js";
import type { AgentRuntimeAuthPlan } from "./types.js";

const CODEX_HARNESS_AUTH_PROVIDER = "openai";
const EMPTY_PROVIDER_AUTH_ALIAS_METADATA = {
  plugins: [],
} satisfies NonNullable<ProviderAuthAliasLookupParams["metadataSnapshot"]>;

function resolveHarnessAuthProvider(params: {
  harnessId?: string;
  harnessRuntime?: string;
}): string | undefined {
  const harnessId = normalizeOptionalAgentRuntimeId(params.harnessId);
  const runtime = normalizeOptionalAgentRuntimeId(params.harnessRuntime);
  return harnessId === "codex" || runtime === "codex" ? CODEX_HARNESS_AUTH_PROVIDER : undefined;
}

export function buildAgentRuntimeAuthPlan(params: {
  provider: string;
  authProfileProvider?: string;
  authProfileMode?: string;
  sessionAuthProfileId?: string;
  sessionAuthProfileCandidateIds?: string[];
  config?: OpenClawConfig;
  workspaceDir?: string;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
  providerAuthAliasesEnabled?: boolean;
  harnessId?: string;
  harnessRuntime?: string;
  allowHarnessAuthProfileForwarding?: boolean;
}): AgentRuntimeAuthPlan {
  const providerAuthAliasesEnabled =
    params.providerAuthAliasesEnabled ??
    (params.config ? normalizePluginsConfig(params.config.plugins).enabled : true);
  const metadataSnapshot =
    params.metadataSnapshot ??
    (providerAuthAliasesEnabled ? undefined : EMPTY_PROVIDER_AUTH_ALIAS_METADATA);
  const aliasLookupParams = {
    config: params.config,
    workspaceDir: params.workspaceDir,
    ...(metadataSnapshot ? { metadataSnapshot } : {}),
  };
  const providerForAuth = resolveProviderIdForAuth(params.provider, aliasLookupParams);
  const authProfileProviderForAuth = resolveProviderIdForAuth(
    params.authProfileProvider ?? params.provider,
    aliasLookupParams,
  );
  const harnessAuthProvider = resolveHarnessAuthProvider(params);
  const harnessProviderForAuth = harnessAuthProvider
    ? resolveProviderIdForAuth(harnessAuthProvider, aliasLookupParams)
    : undefined;
  const harnessCanForwardProfile =
    params.allowHarnessAuthProfileForwarding !== false &&
    harnessProviderForAuth &&
    harnessProviderForAuth === authProfileProviderForAuth;
  const providerCanForwardProfile =
    !harnessProviderForAuth && providerForAuth === authProfileProviderForAuth;
  const canForwardProfile = providerCanForwardProfile || harnessCanForwardProfile;

  return {
    providerForAuth,
    authProfileProviderForAuth,
    ...(harnessProviderForAuth ? { harnessAuthProvider: harnessProviderForAuth } : {}),
    ...(canForwardProfile ? { forwardedAuthProfileId: params.sessionAuthProfileId } : {}),
    ...(canForwardProfile && params.sessionAuthProfileCandidateIds?.length
      ? { forwardedAuthProfileCandidateIds: params.sessionAuthProfileCandidateIds }
      : {}),
  };
}
