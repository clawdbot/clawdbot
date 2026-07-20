// Model/auth provider selection step shared by the classic wizard and bootstrap onboarding.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { AuthChoice, OnboardOptions } from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { t } from "./i18n/index.js";
import { WizardCancelledError, type WizardPrompter } from "./prompts.js";

type KeepCurrentAuthChoice =
  typeof import("../commands/auth-choice-prompt.js").KEEP_CURRENT_AUTH_CHOICE;
type PreparedAuthChoiceResult = Awaited<
  ReturnType<typeof import("../commands/auth-choice.js").prepareAuthChoice>
>;

export type SetupModelAuthCandidate = {
  config: OpenClawConfig;
  authProfiles: PreparedAuthChoiceResult["authProfiles"];
  persistAuthProfiles: PreparedAuthChoiceResult["persistAuthProfiles"];
};

const loadAuthChoiceModule = createLazyRuntimeModule(() => import("../commands/auth-choice.js"));

const loadModelPickerModule = createLazyRuntimeModule(() => import("../commands/model-picker.js"));

function isAuthChoiceSelected(
  value: AuthChoice | KeepCurrentAuthChoice,
  keepCurrentAuthChoice: KeepCurrentAuthChoice | undefined,
): value is AuthChoice {
  return keepCurrentAuthChoice === undefined || value !== keepCurrentAuthChoice;
}

async function resolveAuthChoiceModelSelectionPolicy(params: {
  authChoice: string;
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  resolvePreferredProviderForAuthChoice: (params: {
    choice: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  }) => Promise<string | undefined>;
}): Promise<{
  preferredProvider?: string;
  promptWhenAuthChoiceProvided: boolean;
  allowKeepCurrent: boolean;
}> {
  const preferredProvider = await params.resolvePreferredProviderForAuthChoice({
    choice: params.authChoice,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });

  const [{ resolveManifestProviderAuthChoice }, { resolvePluginSetupProvider }] = await Promise.all(
    [import("../plugins/provider-auth-choices.js"), import("../plugins/setup-registry.js")],
  );
  const manifestChoice = resolveManifestProviderAuthChoice(params.authChoice, {
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    includeUntrustedWorkspacePlugins: false,
  });
  if (manifestChoice) {
    const setupProvider = resolvePluginSetupProvider({
      provider: manifestChoice.providerId,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      pluginIds: [manifestChoice.pluginId],
    });
    const setupMethod = setupProvider?.auth.find(
      (method) => normalizeProviderId(method.id) === normalizeProviderId(manifestChoice.methodId),
    );
    const setupPolicy =
      setupMethod?.wizard?.modelSelection ?? setupProvider?.wizard?.setup?.modelSelection;
    return {
      preferredProvider,
      promptWhenAuthChoiceProvided: setupPolicy?.promptWhenAuthChoiceProvided === true,
      allowKeepCurrent: setupPolicy?.allowKeepCurrent ?? true,
    };
  }

  const { resolvePluginProviders, resolveProviderPluginChoice } =
    await import("../plugins/provider-auth-choice.runtime.js");
  const providers = resolvePluginProviders({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    mode: "setup",
  });
  const resolvedChoice = resolveProviderPluginChoice({
    providers,
    choice: params.authChoice,
  });
  const matchedProvider =
    resolvedChoice?.provider ??
    (() => {
      const preferredId = preferredProvider?.trim();
      if (!preferredId) {
        return undefined;
      }
      return providers.find(
        (provider) => typeof provider.id === "string" && provider.id.trim() === preferredId,
      );
    })();
  const setupPolicy =
    resolvedChoice?.wizard?.modelSelection ?? matchedProvider?.wizard?.setup?.modelSelection;

  return {
    preferredProvider,
    promptWhenAuthChoiceProvided: setupPolicy?.promptWhenAuthChoiceProvided === true,
    allowKeepCurrent: setupPolicy?.allowKeepCurrent ?? true,
  };
}

/**
 * Run the provider auth-choice + default-model selection loop. When
 * `opts.authChoice` is set the prompt is skipped and the flag drives the flow
 * (public onboarding automation contract).
 */
export async function runSetupModelAuthStep(params: {
  config: OpenClawConfig;
  stagedCandidate?: SetupModelAuthCandidate;
  opts: OnboardOptions;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir: string;
}): Promise<SetupModelAuthCandidate> {
  const { opts, prompter, runtime, workspaceDir } = params;
  let nextConfig = params.stagedCandidate?.config ?? params.config;
  let replacementBaseConfig = params.config;
  let authProfiles: PreparedAuthChoiceResult["authProfiles"] =
    params.stagedCandidate?.authProfiles ?? [];
  let persistAuthProfiles: PreparedAuthChoiceResult["persistAuthProfiles"] =
    params.stagedCandidate?.persistAuthProfiles ?? (async () => {});
  const authChoiceFromPrompt = opts.authChoice === undefined;
  let authChoice: AuthChoice | KeepCurrentAuthChoice | undefined = opts.authChoice;
  let authStore:
    | ReturnType<(typeof import("../agents/auth-profiles.runtime.js"))["ensureAuthProfileStore"]>
    | undefined;
  let promptAuthChoiceGrouped:
    | (typeof import("../commands/auth-choice-prompt.js"))["promptAuthChoiceGrouped"]
    | undefined;
  let keepCurrentAuthChoice: KeepCurrentAuthChoice | undefined;
  if (authChoiceFromPrompt) {
    const { ensureAuthProfileStore } = await import("../agents/auth-profiles.runtime.js");
    const authChoicePromptModule = await import("../commands/auth-choice-prompt.js");
    promptAuthChoiceGrouped = authChoicePromptModule.promptAuthChoiceGrouped;
    keepCurrentAuthChoice = authChoicePromptModule.KEEP_CURRENT_AUTH_CHOICE;
    authStore = ensureAuthProfileStore(undefined, {
      allowKeychainPrompt: false,
    });
  }
  while (true) {
    if (authChoiceFromPrompt) {
      authChoice = await promptAuthChoiceGrouped!({
        prompter,
        store: authStore!,
        includeSkip: true,
        config: nextConfig,
        workspaceDir,
        allowKeepCurrentProvider: true,
      });
    }
    if (authChoice === undefined) {
      throw new WizardCancelledError(t("wizard.setup.authChoiceRequired"));
    }
    if (!isAuthChoiceSelected(authChoice, keepCurrentAuthChoice)) {
      break;
    }

    // A new auth choice replaces the rejected candidate instead of layering onto it.
    nextConfig = replacementBaseConfig;
    authProfiles = [];
    persistAuthProfiles = async () => {};

    if (authChoice === "custom-api-key") {
      const { promptCustomApiConfig } = await import("../commands/onboard-custom.js");
      const customResult = await promptCustomApiConfig({
        prompter,
        runtime,
        config: nextConfig,
        secretInputMode: opts.secretInputMode,
      });
      nextConfig = customResult.config;
      prompter.disableBackNavigation?.();
      break;
    }
    if (authChoice === "skip") {
      // Explicit skip should stay cold: do not bootstrap auth/profile machinery
      // or run model/auth checks when the caller already chose to skip setup.
      if (authChoiceFromPrompt) {
        const { applyPrimaryModel, promptDefaultModel } = await loadModelPickerModule();
        const modelSelection = await promptDefaultModel({
          config: nextConfig,
          prompter,
          allowKeep: true,
          ignoreAllowlist: true,
          includeProviderPluginSetups: false,
          loadCatalog: false,
          workspaceDir,
          runtime,
        });
        if (modelSelection.config) {
          nextConfig = modelSelection.config;
        }
        if (modelSelection.model) {
          nextConfig = applyPrimaryModel(nextConfig, modelSelection.model);
        }

        const { warnIfModelConfigLooksOff } = await loadAuthChoiceModule();
        await warnIfModelConfigLooksOff(nextConfig, prompter, { validateCatalog: false });
      }
      break;
    }

    const [
      { prepareAuthChoice, resolvePreferredProviderForAuthChoice, warnIfModelConfigLooksOff },
      { applyPrimaryModel, promptDefaultModel },
    ] = await Promise.all([loadAuthChoiceModule(), loadModelPickerModule()]);
    prompter.disableBackNavigation?.();
    let authResult: PreparedAuthChoiceResult;
    try {
      authResult = await prepareAuthChoice({
        authChoice,
        config: nextConfig,
        prompter,
        runtime,
        setDefaultModel: true,
        preserveExistingDefaultModel: true,
        opts: {
          ...opts,
          token: opts.authChoice === "apiKey" && opts.token ? opts.token : undefined,
        },
      });
    } catch (error) {
      // Provider setup failures (missing CLI login, unreachable endpoint, ...)
      // must not kill the whole wizard: earlier answers only persist later, so
      // re-prompt instead. Explicit --auth-choice callers still fail loudly.
      if (error instanceof WizardCancelledError || !authChoiceFromPrompt) {
        throw error;
      }
      await prompter.note(
        [formatErrorMessage(error), t("wizard.setup.authChoiceFailedRetry")].join("\n"),
        t("wizard.setup.authChoiceFailedTitle"),
      );
      continue;
    }
    nextConfig = authResult.config;
    authProfiles = authResult.authProfiles;
    persistAuthProfiles = authResult.persistAuthProfiles;
    if (authResult.retrySelection) {
      if (authChoiceFromPrompt) {
        replacementBaseConfig = authResult.config;
        continue;
      }
      break;
    }
    if (authResult.agentModelOverride) {
      nextConfig = applyPrimaryModel(nextConfig, authResult.agentModelOverride);
    }

    const authChoiceModelSelectionPolicy = await resolveAuthChoiceModelSelectionPolicy({
      authChoice,
      config: nextConfig,
      workspaceDir,
      resolvePreferredProviderForAuthChoice,
    });
    const shouldPromptModelSelection =
      authChoiceFromPrompt || authChoiceModelSelectionPolicy?.promptWhenAuthChoiceProvided;
    if (shouldPromptModelSelection) {
      const modelSelection = await promptDefaultModel({
        config: nextConfig,
        prompter,
        allowKeep: authChoiceModelSelectionPolicy?.allowKeepCurrent ?? true,
        ignoreAllowlist: true,
        includeProviderPluginSetups: true,
        preferredProvider: authChoiceModelSelectionPolicy?.preferredProvider,
        browseCatalogOnDemand: true,
        workspaceDir,
        runtime,
      });
      if (modelSelection.config) {
        nextConfig = modelSelection.config;
      }
      if (modelSelection.model) {
        nextConfig = applyPrimaryModel(nextConfig, modelSelection.model);
      }
    }

    await warnIfModelConfigLooksOff(nextConfig, prompter, { validateCatalog: false });
    break;
  }
  return { config: nextConfig, authProfiles, persistAuthProfiles };
}
