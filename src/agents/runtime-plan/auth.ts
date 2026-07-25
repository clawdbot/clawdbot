/**
 * Builds auth forwarding decisions for prepared runtime plans. Provider aliases
 * and harness auth owners are resolved before session auth profiles can be
 * safely forwarded.
 */
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
// Empty metadata disables plugin alias lookups without changing the downstream
// resolver contract, matching the "plugins disabled" runtime-plan state.
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

/** Builds the auth forwarding plan for one resolved agent runtime. */
export function buildAgentRuntimeAuthPlan(params: {
  provider: string;
  modelId?: string;
  authProfileProvider?: string;
  authProfileMode?: string;
  sessionAuthProfileId?: string;
  sessionAuthProfileSource?: "auto" | "user";
  sessionAuthProfileCandidateIds?: string[];
  modelRoute?: AgentRuntimeAuthPlan["modelRoute"];
  deferredRouteSupport?: AgentRuntimeAuthPlan["deferredRouteSupport"];
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
  const forwardedAuthProfileId = canForwardProfile ? params.sessionAuthProfileId : undefined;

  // Forward only when the selected provider/harness resolves to the same auth
  // owner as the stored session profile; otherwise the runtime must choose auth.
  return {
    providerForAuth,
    ...(params.modelId ? { modelId: params.modelId } : {}),
    authProfileProviderForAuth,
    ...(harnessProviderForAuth ? { harnessAuthProvider: harnessProviderForAuth } : {}),
    ...(canForwardProfile ? { forwardedAuthProfileId } : {}),
    ...(canForwardProfile && params.sessionAuthProfileId && params.sessionAuthProfileSource
      ? { forwardedAuthProfileSource: params.sessionAuthProfileSource }
      : {}),
    ...(canForwardProfile && params.sessionAuthProfileCandidateIds?.length
      ? { forwardedAuthProfileCandidateIds: params.sessionAuthProfileCandidateIds }
      : {}),
    ...(canForwardProfile && params.authProfileMode
      ? { selectedAuthMode: params.authProfileMode }
      : {}),
    ...(params.modelRoute ? { modelRoute: params.modelRoute } : {}),
    ...(params.deferredRouteSupport ? { deferredRouteSupport: params.deferredRouteSupport } : {}),
  } satisfies AgentRuntimeAuthPlan;
}
