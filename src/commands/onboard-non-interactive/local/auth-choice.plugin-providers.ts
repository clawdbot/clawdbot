/**
 * Applies non-interactive setup for provider plugins.
 *
 * This path resolves trusted plugin providers, delegates setup to their
 * non-interactive method, and installs runtime plugins required by the model.
 */
import { sanitizeTerminalText } from "../../../../packages/terminal-core/src/safe-text.js";
import type { ApiKeyCredential } from "../../../agents/auth-profiles/types.js";
import { quoteCliArg } from "../../../cli/quote-cli-arg.js";
import { applyAutoLocalModelLean } from "../../../config/local-model-lean-auto.js";
import { resolveAgentModelPrimaryValue } from "../../../config/model-input.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { enablePluginWithCapabilityConsent } from "../../../plugins/enable.js";
import { prepareProviderAuthChoiceRuntime } from "../../../plugins/provider-auth-choice.js";
import { resolveManifestProviderAuthChoice } from "../../../plugins/provider-auth-choices.js";
import { resolveDeprecatedProviderInstallCatalogEntry } from "../../../plugins/provider-install-catalog.js";
import type {
  ProviderAuthOptionBag,
  ProviderNonInteractiveApiKeyCredentialParams,
  ProviderResolveNonInteractiveApiKeyParams,
} from "../../../plugins/types.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { createNonInteractiveLoggingPrompter } from "../../non-interactive-prompter.js";
import {
  prepareAgentModelDefaults,
  projectAgentModelDefaults,
  type OnboardingAgentTarget,
} from "../../onboard-agent-target.js";
import { rejectOnboardingOption } from "../../onboard-options.js";
import type { OnboardOptions } from "../../onboard-types.js";
import {
  CODEX_RUNTIME_PLUGIN_ID,
  ensureModelSelectionRuntimePlugins,
} from "../../runtime-plugin-install.js";

const PROVIDER_PLUGIN_CHOICE_PREFIX = "provider-plugin:";

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
  const reject = (message: string): null => {
    rejectOnboardingOption(params.opts, params.runtime, message);
    return null;
  };
  const prefixedProviderId = params.authChoice.startsWith(PROVIDER_PLUGIN_CHOICE_PREFIX)
    ? params.authChoice.slice(PROVIDER_PLUGIN_CHOICE_PREFIX.length).split(":", 1)[0]?.trim()
    : undefined;
  // Prefixed choices bypass generic validation, so reject empty IDs before provider discovery.
  if (prefixedProviderId === "") {
    return reject(
      `Auth choice ${JSON.stringify(params.authChoice)} is missing a provider id. Use "${PROVIDER_PLUGIN_CHOICE_PREFIX}<provider-id>".`,
    );
  }
  // Installation progress belongs on stderr when stdout carries the final JSON result.
  const preparationRuntime = params.opts.json
    ? { ...params.runtime, log: params.runtime.error }
    : params.runtime;
  const prepared = await prepareProviderAuthChoiceRuntime({
    authChoice: params.authChoice,
    config: params.nextConfig,
    agentId: params.target.agentId,
    agentDir,
    workspaceDir,
    runtime: preparationRuntime,
    prompter: createNonInteractiveLoggingPrompter(
      preparationRuntime,
      (message) => `Non-interactive setup cannot prompt for plugin install: ${message}`,
    ),
    promptInstall: false,
  });
  if (prepared.status !== "ready") {
    if (prepared.status !== "unavailable") {
      return reject(prepared.message);
    }
    if (prefixedProviderId) {
      // Explicit provider-plugin choices are user intent; fail closed if the
      // target provider is unavailable rather than falling back to core auth.
      return reject(
        [
          `Auth choice "${params.authChoice}" was not matched to a trusted provider plugin.`,
          "If this provider comes from a workspace plugin, trust/allow it first and retry.",
        ].join("\n"),
      );
    }
    // Keep mismatch diagnostics metadata-only so untrusted workspace plugins are not loaded.
    const untrustedOnlyManifestMatch = resolveManifestProviderAuthChoice(params.authChoice, {
      config: prepared.config,
      workspaceDir,
      includeUntrustedWorkspacePlugins: true,
    });
    if (untrustedOnlyManifestMatch) {
      // Manifest metadata can identify untrusted matches without loading the
      // plugin implementation, preserving workspace trust boundaries.
      return reject(
        [
          `Auth choice "${params.authChoice}" matched a provider plugin that is not trusted or enabled for setup.`,
          "If this provider comes from a workspace plugin, trust/allow it first and retry.",
        ].join("\n"),
      );
    }
    const deprecatedInstallCatalogEntry = resolveDeprecatedProviderInstallCatalogEntry(
      params.authChoice,
      { config: prepared.config, workspaceDir, includeUntrustedWorkspacePlugins: false },
    );
    if (deprecatedInstallCatalogEntry) {
      return reject(
        `${JSON.stringify(params.authChoice)} is no longer supported. Use --auth-choice ${quoteCliArg(sanitizeTerminalText(deprecatedInstallCatalogEntry.choiceId))} instead.`,
      );
    }
    return undefined;
  }

  let nextConfig = prepared.config;
  const { provider, method } = prepared;
  if (!prepared.choice) {
    // Shipped runtime-only CLI choices enable their owner after discovery;
    // manifest-backed choices were already reviewed and enabled during preparation.
    const enabled = await enablePluginWithCapabilityConsent(
      nextConfig,
      provider.pluginId ?? provider.id,
      { workspaceDir },
    );
    if (!enabled.enabled) {
      return reject(`${provider.label} plugin is disabled (${enabled.reason ?? "blocked"}).`);
    }
    nextConfig = enabled.config;
  }

  if (!method.runNonInteractive) {
    // Interactive-only plugin setup methods may prompt, so non-interactive
    // setup must reject them before entering plugin code.
    return reject(
      [
        `Auth choice "${params.authChoice}" requires interactive mode.`,
        `The ${provider.label} provider plugin does not implement non-interactive setup.`,
      ].join("\n"),
    );
  }

  const agentScopedModels = nextConfig.agents?.ownership === "explicit";
  const providerConfig = agentScopedModels
    ? prepareAgentModelDefaults(nextConfig, params.target)
    : nextConfig;
  const projectProviderResult = (updated: OpenClawConfig) =>
    agentScopedModels ? projectAgentModelDefaults(nextConfig, params.target, updated) : updated;
  const result = await method.runNonInteractive({
    authChoice: params.authChoice,
    config: providerConfig,
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
    return projectProviderResult(result);
  }
  // Model selection can imply a runtime plugin even when auth setup belonged to
  // a provider plugin; install those runtimes before persisting the config.
  const runtimes = await ensureModelSelectionRuntimePlugins({
    cfg: result,
    model: selectedModel,
    prompter: createNonInteractiveLoggingPrompter(params.runtime, (message) => message),
    runtime: params.runtime,
    workspaceDir,
    output: "silent",
  });
  if (!runtimes.ok) {
    return reject(runtimes.message);
  }
  if (runtimes.codexInstalled) {
    // Non-interactive onboarding never auto-applies migration; emit a hint so
    // the operator knows Codex CLI state is available to import deliberately.
    // Gated on installed (not freshlyInstalled) so repair runs against an
    // already-present harness still surface the hint.
    const { offerPostInstallMigrations } =
      await import("../../../wizard/setup.post-install-migration.js");
    await offerPostInstallMigrations({
      config: runtimes.cfg,
      runtime: params.runtime,
      installedPluginIds: [CODEX_RUNTIME_PLUGIN_ID],
      nonInteractive: true,
    });
  }
  const previousModel = providerConfig.agents?.defaults?.model;
  const previousAutoModel = nextConfig.wizard?.localModelLeanAutoModel;
  const retainsAutoModelOwnership =
    previousAutoModel !== undefined &&
    previousAutoModel === resolveAgentModelPrimaryValue(previousModel) &&
    previousAutoModel === runtimes.cfg.wizard?.localModelLeanAutoModel;

  return projectProviderResult(
    applyAutoLocalModelLean({
      config: runtimes.cfg,
      providerId: provider.id,
      modelRef: selectedModel,
      ...(retainsAutoModelOwnership ? { previousModelRef: previousAutoModel } : {}),
    }).config,
  );
}
