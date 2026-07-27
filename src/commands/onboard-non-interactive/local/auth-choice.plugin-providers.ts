/**
 * Applies non-interactive setup for provider plugins.
 *
 * This path resolves trusted plugin providers, delegates setup to their
 * non-interactive method, and installs runtime plugins required by the model.
 */
import type { ApiKeyCredential } from "../../../agents/auth-profiles/types.js";
import { resolveAgentModelPrimaryValue } from "../../../config/model-input.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { enablePluginInConfig } from "../../../plugins/enable.js";
import { resolvePreferredProviderForAuthChoice } from "../../../plugins/provider-auth-choice-preference.js";
import { resolveManifestProviderAuthChoice } from "../../../plugins/provider-auth-choices.js";
import {
  resolveDeprecatedProviderInstallCatalogEntry,
  resolveProviderInstallCatalogEntry,
} from "../../../plugins/provider-install-catalog.js";
import type {
  ProviderAuthOptionBag,
  ProviderNonInteractiveApiKeyCredentialParams,
  ProviderResolveNonInteractiveApiKeyParams,
} from "../../../plugins/types.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { createLazyRuntimeSurface } from "../../../shared/lazy-runtime.js";
import {
  CODEX_RUNTIME_PLUGIN_ID,
  ensureCodexRuntimePluginForModelSelection,
} from "../../codex-runtime-plugin-install.js";
import { ensureCopilotRuntimePluginForModelSelection } from "../../copilot-runtime-plugin-install.js";
import { createNonInteractiveLoggingPrompter } from "../../non-interactive-prompter.js";
import type { OnboardingAgentTarget } from "../../onboard-agent-target.js";
import type { OnboardOptions } from "../../onboard-types.js";

const PROVIDER_PLUGIN_CHOICE_PREFIX = "provider-plugin:";

async function loadPluginProviderRuntime() {
  return import("./auth-choice.plugin-providers.runtime.js");
}

const loadAuthChoicePluginProvidersRuntime = createLazyRuntimeSurface(
  loadPluginProviderRuntime,
  ({ authChoicePluginProvidersRuntime }) => authChoicePluginProvidersRuntime,
);

/** Applies a plugin-defined auth choice, or returns undefined when it is not plugin-backed. */
export async function applyNonInteractivePluginProviderChoice(params: {
  nextConfig: OpenClawConfig;
  authChoice: string;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: OpenClawConfig;
  target: OnboardingAgentTarget;
  resolveApiKey: (input: ProviderResolveNonInteractiveApiKeyParams) => Promise<{
    key: string;
    source: "profile" | "env" | "flag";
    envVarName?: string;
  } | null>;
  toApiKeyCredential: (
    input: ProviderNonInteractiveApiKeyCredentialParams,
  ) => ApiKeyCredential | null;
}): Promise<OpenClawConfig | null | undefined> {
  const { agentDir, workspaceDir } = params.target;
  let nextConfig = params.nextConfig;
  const prefixedProviderId = params.authChoice.startsWith(PROVIDER_PLUGIN_CHOICE_PREFIX)
    ? params.authChoice.slice(PROVIDER_PLUGIN_CHOICE_PREFIX.length).split(":", 1)[0]?.trim()
    : undefined;
  const preferredProviderId =
    prefixedProviderId ||
    (await resolvePreferredProviderForAuthChoice({
      choice: params.authChoice,
      config: nextConfig,
      workspaceDir,
      includeUntrustedWorkspacePlugins: false,
    }));
  // Provider discovery is lazy so non-plugin auth choices do not pull plugin
  // runtime code into the basic non-interactive setup path.
  const {
    resolveOwningPluginIdsForProviderRef,
    resolveProviderPluginChoice,
    resolvePluginProviders,
  } = await loadAuthChoicePluginProvidersRuntime();
  const owningPluginIds = preferredProviderId
    ? resolveOwningPluginIdsForProviderRef({
        provider: preferredProviderId,
        config: nextConfig,
        workspaceDir,
      })
    : undefined;
  let providerChoice = resolveProviderPluginChoice({
    providers: resolvePluginProviders({
      config: nextConfig,
      workspaceDir,
      onlyPluginIds: owningPluginIds,
      mode: "setup",
      includeUntrustedWorkspacePlugins: false,
    }),
    choice: params.authChoice,
  });
  if (!providerChoice) {
    if (prefixedProviderId) {
      // Explicit provider-plugin choices are user intent; fail closed if the
      // target provider is unavailable rather than falling back to core auth.
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
      config: nextConfig,
      workspaceDir,
      includeUntrustedWorkspacePlugins: false,
    });
    const untrustedOnlyManifestMatch =
      !trustedManifestMatch &&
      resolveManifestProviderAuthChoice(params.authChoice, {
        config: nextConfig,
        workspaceDir,
        includeUntrustedWorkspacePlugins: true,
      });
    if (untrustedOnlyManifestMatch) {
      // Manifest metadata can identify untrusted matches without loading the
      // plugin implementation, preserving workspace trust boundaries.
      params.runtime.error(
        [
          `Auth choice "${params.authChoice}" matched a provider plugin that is not trusted or enabled for setup.`,
          "If this provider comes from a workspace plugin, trust/allow it first and retry.",
        ].join("\n"),
      );
      params.runtime.exit(1);
      return null;
    }
    const installCatalogParams = {
      config: nextConfig,
      workspaceDir,
      includeUntrustedWorkspacePlugins: false,
    };
    const deprecatedInstallCatalogEntry = resolveDeprecatedProviderInstallCatalogEntry(
      params.authChoice,
      installCatalogParams,
    );
    if (deprecatedInstallCatalogEntry) {
      params.runtime.error(
        `${JSON.stringify(params.authChoice)} is no longer supported. Use --auth-choice ${JSON.stringify(deprecatedInstallCatalogEntry.choiceId)} instead.`,
      );
      params.runtime.exit(1);
      return null;
    }
    const installCatalogEntry = resolveProviderInstallCatalogEntry(
      params.authChoice,
      installCatalogParams,
    );
    if (!installCatalogEntry) {
      return undefined;
    }
    const { ensureOnboardingPluginInstalled } = await import("../../onboarding-plugin-install.js");
    const installResult = await ensureOnboardingPluginInstalled({
      cfg: nextConfig,
      entry: {
        pluginId: installCatalogEntry.pluginId,
        label: installCatalogEntry.label,
        install: installCatalogEntry.install,
        ...(installCatalogEntry.origin === "bundled"
          ? { trustedSourceLinkedOfficialInstall: true }
          : {}),
      },
      prompter: createNonInteractiveLoggingPrompter(
        params.runtime,
        (message) => `Non-interactive setup cannot prompt for plugin install: ${message}`,
      ),
      runtime: params.runtime,
      workspaceDir,
      promptInstall: false,
    });
    if (!installResult.installed) {
      params.runtime.error(
        `Unable to install the ${installCatalogEntry.label} plugin for non-interactive setup.`,
      );
      params.runtime.exit(1);
      return null;
    }
    nextConfig = installResult.cfg;
    providerChoice = resolveProviderPluginChoice({
      providers: resolvePluginProviders({
        config: nextConfig,
        workspaceDir,
        onlyPluginIds: [installCatalogEntry.pluginId],
        mode: "setup",
        includeUntrustedWorkspacePlugins: false,
      }),
      choice: params.authChoice,
    });
    if (!providerChoice) {
      params.runtime.error(
        `Installed plugin "${installCatalogEntry.label}" did not expose auth choice "${params.authChoice}".`,
      );
      params.runtime.exit(1);
      return null;
    }
  }

  const enableResult = enablePluginInConfig(
    nextConfig,
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
    // Interactive-only plugin setup methods may prompt, so non-interactive
    // setup must reject them before entering plugin code.
    params.runtime.error(
      [
        `Auth choice "${params.authChoice}" requires interactive mode.`,
        `The ${providerChoice.provider.label} provider plugin does not implement non-interactive setup.`,
      ].join("\n"),
    );
    params.runtime.exit(1);
    return null;
  }

  const result = await method.runNonInteractive({
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
  if (!result) {
    return result;
  }
  const selectedModel = resolveAgentModelPrimaryValue(result.agents?.defaults?.model);
  if (!selectedModel) {
    return result;
  }
  // Model selection can imply a runtime plugin even when auth setup belonged to
  // a provider plugin; install those runtimes before persisting the config.
  const nonInteractivePrompter = createNonInteractiveLoggingPrompter(
    params.runtime,
    (message) => `Non-interactive setup cannot prompt for plugin install: ${message}`,
  );
  const codexInstall = await ensureCodexRuntimePluginForModelSelection({
    cfg: result,
    model: selectedModel,
    prompter: nonInteractivePrompter,
    runtime: params.runtime,
    workspaceDir,
  });
  if (codexInstall.installed) {
    // Non-interactive onboarding never auto-applies migration; emit a hint so
    // the operator knows Codex CLI state is available to import deliberately.
    // Gated on installed (not freshlyInstalled) so repair runs against an
    // already-present harness still surface the hint.
    const { offerPostInstallMigrations } =
      await import("../../../wizard/setup.post-install-migration.js");
    await offerPostInstallMigrations({
      config: codexInstall.cfg,
      runtime: params.runtime,
      installedPluginIds: [CODEX_RUNTIME_PLUGIN_ID],
      nonInteractive: true,
    });
  }
  const copilotInstall = await ensureCopilotRuntimePluginForModelSelection({
    cfg: codexInstall.cfg,
    model: selectedModel,
    prompter: nonInteractivePrompter,
    runtime: params.runtime,
    workspaceDir,
  });
  return copilotInstall.cfg;
}
