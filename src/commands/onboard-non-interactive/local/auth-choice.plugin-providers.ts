import {
  resolveAgentDir,
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
} from "../../../agents/agent-scope.js";
import type { ApiKeyCredential } from "../../../agents/auth-profiles/types.js";
import { resolveDefaultAgentWorkspaceDir } from "../../../agents/workspace.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { enablePluginInConfig } from "../../../plugins/enable.js";
import { resolvePreferredProviderForAuthChoice } from "../../../plugins/provider-auth-choice-preference.js";
import { resolveManifestProviderAuthChoice } from "../../../plugins/provider-auth-choices.js";
import type {
  ProviderAuthOptionBag,
  ProviderNonInteractiveApiKeyCredentialParams,
  ProviderResolveNonInteractiveApiKeyParams,
} from "../../../plugins/types.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { createLazyRuntimeSurface } from "../../../shared/lazy-runtime.js";
import type { OnboardOptions } from "../../onboard-types.js";

const PROVIDER_PLUGIN_CHOICE_PREFIX = "provider-plugin:";

async function loadPluginProviderRuntime() {
  return import("./auth-choice.plugin-providers.runtime.js");
}

const loadAuthChoicePluginProvidersRuntime = createLazyRuntimeSurface(
  loadPluginProviderRuntime,
  ({ authChoicePluginProvidersRuntime }) => authChoicePluginProvidersRuntime,
);

export async function applyNonInteractivePluginProviderChoice(params: {
  nextConfig: OpenClawConfig;
  authChoice: string;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: OpenClawConfig;
  resolveApiKey: (input: ProviderResolveNonInteractiveApiKeyParams) => Promise<{
    key: string;
    source: "profile" | "env" | "flag";
    envVarName?: string;
  } | null>;
  toApiKeyCredential: (
    input: ProviderNonInteractiveApiKeyCredentialParams,
  ) => ApiKeyCredential | null;
}): Promise<OpenClawConfig | null | undefined> {
  const agentId = resolveDefaultAgentId(params.nextConfig);
  const agentDir = resolveAgentDir(params.nextConfig, agentId);
  const workspaceDir =
    resolveAgentWorkspaceDir(params.nextConfig, agentId) ?? resolveDefaultAgentWorkspaceDir();
  const prefixedProviderId = params.authChoice.startsWith(PROVIDER_PLUGIN_CHOICE_PREFIX)
    ? params.authChoice.slice(PROVIDER_PLUGIN_CHOICE_PREFIX.length).split(":", 1)[0]?.trim()
    : undefined;
  const preferredProviderId =
    prefixedProviderId ||
    (await resolvePreferredProviderForAuthChoice({
      choice: params.authChoice,
      config: params.nextConfig,
      workspaceDir,
      includeUntrustedWorkspacePlugins: false,
    }));
  const { resolveOwningPluginIdsForProvider, resolveProviderPluginChoice, resolvePluginProviders } =
    await loadAuthChoicePluginProvidersRuntime();
  const owningPluginIds = preferredProviderId
    ? resolveOwningPluginIdsForProvider({
        provider: preferredProviderId,
        config: params.nextConfig,
        workspaceDir,
      })
    : undefined;
  const providerChoice = resolveProviderPluginChoice({
    providers: resolvePluginProviders({
      config: params.nextConfig,
      workspaceDir,
      onlyPluginIds: owningPluginIds,
      mode: "setup",
      includeUntrustedWorkspacePlugins: false,
    }),
    choice: params.authChoice,
  });
  if (!providerChoice) {
    if (prefixedProviderId) {
      params.runtime.error(
        [
          `Auth choice "${params.authChoice}" was not matched to a trusted provider plugin.`,
          "If this provider comes from a workspace plugin, trust/allow it first and retry.",
        ].join("\n"),
      );
      params.runtime.exit(1);
      return null;
    }
    // Keep mismatch diagnostics metadata-only so untrusted workspace plugins are not loaded.
    const trustedManifestMatch = resolveManifestProviderAuthChoice(params.authChoice, {
      config: params.nextConfig,
      workspaceDir,
      includeUntrustedWorkspacePlugins: false,
    });
    const untrustedOnlyManifestMatch =
      !trustedManifestMatch &&
      resolveManifestProviderAuthChoice(params.authChoice, {
        config: params.nextConfig,
        workspaceDir,
        includeUntrustedWorkspacePlugins: true,
      });
    if (untrustedOnlyManifestMatch) {
      params.runtime.error(
        [
          `Auth choice "${params.authChoice}" matched a provider plugin that is not trusted or enabled for setup.`,
          "If this provider comes from a workspace plugin, trust/allow it first and retry.",
        ].join("\n"),
      );
      params.runtime.exit(1);
      return null;
    }
    return undefined;
  }

  const enableResult = enablePluginInConfig(
    params.nextConfig,
    providerChoice.provider.pluginId ?? providerChoice.provider.id,
  );
  if (!enableResult.enabled) {
    params.runtime.error(
      `${providerChoice.provider.label} plugin is disabled (${enableResult.reason ?? "blocked"}).`,
    );
    params.runtime.exit(1);
    return null;
  }

  const method = providerChoice.method;
  if (!method.runNonInteractive) {
    params.runtime.error(
      [
        `Auth choice "${params.authChoice}" requires interactive mode.`,
        `The ${providerChoice.provider.label} provider plugin does not implement non-interactive setup.`,
      ].join("\n"),
    );
    params.runtime.exit(1);
    return null;
  }

  return method.runNonInteractive({
    authChoice: params.authChoice,
    config: enableResult.config,
    baseConfig: params.baseConfig,
    opts: params.opts as ProviderAuthOptionBag,
    runtime: params.runtime,
    agentDir,
    workspaceDir,
    resolveApiKey: params.resolveApiKey,
    toApiKeyCredential: params.toApiKeyCredential,
  });
}
