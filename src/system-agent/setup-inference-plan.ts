import { resolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { resolveCliRuntimeCanonicalProvider } from "../agents/cli-backends.js";
import type { CodexCliApiKeyCredential } from "../agents/cli-credentials.js";
import { CliExecutionAuthProfileError } from "../agents/cli-execution-auth.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import {
  ANTHROPIC_API_DEFAULT_MODEL_REF,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CODEX_APP_SERVER_DEFAULT_MODEL_REF,
  GEMINI_CLI_DEFAULT_MODEL_REF,
  OPENAI_API_DEFAULT_MODEL_REF,
} from "../commands/onboard-inference.js";
import { createMergePatch } from "../config/merge-patch.js";
import { normalizeAgentModelRefForConfig } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  applyProviderPluginAuthMethodResultConfig,
  runProviderPluginAuthMethodUnpersisted,
} from "../plugins/provider-auth-choice.js";
import { resolveManifestProviderAuthChoice } from "../plugins/provider-auth-choices.js";
import { resolveProviderInstallCatalogEntry } from "../plugins/provider-install-catalog.js";
import type { ProviderAuthResult } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import { createQuickstartNotePrompter } from "./setup-apply.js";
import {
  supportsSetupManualSecret,
  supportsSetupTextInference,
} from "./setup-inference-auth-options.js";
import {
  type ActivateSetupInferenceDeps,
  SetupInferenceCancelledError,
  type SetupInferenceFailureStatus,
  type SetupInferenceKind,
  parseProviderAutoSetupChoiceId,
  throwIfSetupInferenceCancelled,
  waitForProviderAuth,
} from "./setup-inference-core.js";
import {
  type SetupInferenceTestPlan,
  buildPreparedProviderTestPlan,
  canonicalizeSetupModelRef,
  parseRef,
  prepareManualAuthForActivation,
} from "./setup-inference-plan-helpers.js";
import {
  readSetupProviderNamespaces,
  runProviderManualSecretMethod,
} from "./setup-inference-plan-provider-auth.js";
import { prepareSetupProviderAuthChoice } from "./setup-inference-provider-install.js";

export async function buildTestPlan(params: {
  kind: SetupInferenceKind | "api-key" | "provider-auth";
  modelRef?: string;
  authChoice?: string;
  apiKey?: string;
  cfg: OpenClawConfig;
  sourceCfg: OpenClawConfig;
  workspaceDir: string;
  pluginWorkspaceDir: string;
  agentDir: string;
  runtime: RuntimeEnv;
  prompter?: WizardPrompter;
  signal?: AbortSignal;
  isCancelled?: () => boolean;
  beforePersistentEffect?: () => void | Promise<void>;
  isRemoteProviderAuth?: boolean;
  routeAgentId?: string;
  codexCliApiKey?: CodexCliApiKeyCredential;
  deps: ActivateSetupInferenceDeps;
}): Promise<SetupInferenceTestPlan | { error: string; status?: SetupInferenceFailureStatus }> {
  const { kind, cfg, workspaceDir } = params;
  const routeAgentId = resolveAmbientOwnerAgentId(cfg, params.routeAgentId);
  const resolveRouteModelRef = (defaultModelRef: string): string | { error: string } => {
    const modelRef = params.modelRef?.trim() || defaultModelRef;
    const selected = parseRef(modelRef);
    const expected = parseRef(defaultModelRef);
    if (
      !selected.model ||
      normalizeProviderId(selected.provider) !== normalizeProviderId(expected.provider)
    ) {
      return { error: `${modelRef} is not compatible with the ${kind} inference route.` };
    }
    return modelRef;
  };
  const providerAutoChoiceId = parseProviderAutoSetupChoiceId(kind);
  if (providerAutoChoiceId) {
    const choice = (
      params.deps.resolveManifestProviderAuthChoice ?? resolveManifestProviderAuthChoice
    )(providerAutoChoiceId, {
      config: cfg,
      workspaceDir: params.pluginWorkspaceDir,
      includeUntrustedWorkspacePlugins: false,
      includeWorkspacePlugins: false,
    });
    if (
      !choice ||
      choice.appGuidedDiscovery !== true ||
      !supportsSetupTextInference(choice.onboardingScopes)
    ) {
      return { error: "That detected provider is no longer available on this Gateway." };
    }
    const providerChoice = await prepareSetupProviderAuthChoice(params, choice);
    if (providerChoice.error !== undefined) {
      return { error: providerChoice.error };
    }
    const {
      enableResult,
      baseEnableResult,
      sourceEnableResult,
      provider,
      method,
      installationPlugins,
    } = providerChoice;
    if (!provider || !method?.appGuidedSetup) {
      return { error: "That detected provider is no longer available on this Gateway." };
    }
    const modelRef = params.modelRef?.trim();
    if (!modelRef) {
      return { error: "The detected provider model is missing. Run detection again." };
    }
    try {
      const result = await method.appGuidedSetup.prepare({
        config: enableResult.config,
        env: process.env,
        workspaceDir: params.pluginWorkspaceDir,
        modelRef,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      const preparedModelRef = result?.defaultModel
        ? normalizeAgentModelRefForConfig(result.defaultModel)
        : "";
      if (!result || preparedModelRef !== modelRef) {
        return {
          error: `${choice.choiceLabel} could not prepare the detected model. Run detection again.`,
        };
      }
      const ref = parseRef(modelRef);
      if (
        !ref.model ||
        normalizeProviderId(ref.provider) !== normalizeProviderId(choice.providerId)
      ) {
        return { error: `${choice.choiceLabel} returned an invalid detected model.` };
      }
      const preparedConfig = applyProviderPluginAuthMethodResultConfig({
        config: enableResult.config,
        result,
      });
      const matchingProfile = result.profiles.find(
        (profile) =>
          normalizeProviderId(profile.credential.provider) === normalizeProviderId(ref.provider),
      );
      if (result.profiles.length > 0 && !matchingProfile) {
        return {
          error: `${choice.choiceLabel} did not return credentials for its detected model.`,
        };
      }
      return buildPreparedProviderTestPlan({
        cfg: baseEnableResult.config,
        installationPlugins,
        sourceCfg: sourceEnableResult.config,
        preparedConfig,
        profiles: result.profiles,
        selectedProfileId: matchingProfile?.profileId,
        modelRef,
        pluginId: choice.pluginId,
        agentDir: params.agentDir,
        routeAgentId,
      });
    } catch (error) {
      return {
        error: `${choice.choiceLabel} could not prepare app-guided setup: ${formatErrorMessage(error)}`,
      };
    }
  }
  switch (kind) {
    case "existing-model": {
      let route;
      try {
        route = await resolveSystemAgentConfiguredRouteFromConfig(cfg, params.routeAgentId, {
          loadAuthProfileStoreForRuntime: params.deps.loadAuthProfileStoreForRuntime,
        });
      } catch (error) {
        if (error instanceof CliExecutionAuthProfileError) {
          return { error: error.message, status: "auth" as const };
        }
        throw error;
      }
      if (!route) {
        return { error: "No configured default-agent inference route is available." };
      }
      const requestedModelRef = params.modelRef?.trim();
      const requestedTarget = requestedModelRef
        ? canonicalizeSetupModelRef({
            cfg,
            raw: requestedModelRef,
            defaultProvider: route.provider,
          })
        : undefined;
      if (requestedModelRef && requestedTarget !== route.modelLabel) {
        return {
          error: `The configured default model changed from ${requestedModelRef} to ${route.modelLabel}. Try setup again.`,
        };
      }
      return {
        runner: route.runner,
        provider: route.provider,
        model: route.model,
        modelRef: route.modelLabel,
        config: cfg,
        executionConfig: route.runConfig,
        agentId: "openclaw",
        routeAgentId: route.agentId,
        agentDir: route.agentDir,
        ...(route.runner === "embedded" && route.agentHarnessRuntimeOverride
          ? { agentHarnessRuntimeOverride: route.agentHarnessRuntimeOverride }
          : {}),
        ...(route.authProfileId ? { authProfileId: route.authProfileId } : {}),
      };
    }
    case "claude-cli": {
      const modelRef = resolveRouteModelRef(CLAUDE_CLI_DEFAULT_MODEL_REF);
      if (typeof modelRef !== "string") {
        return modelRef;
      }
      const ref = parseRef(modelRef);
      // Backend metadata owns whether a CLI runtime aliases a canonical provider.
      // Standalone CLI backends keep their runtime provider as the durable key.
      const persistProvider =
        resolveCliRuntimeCanonicalProvider({
          runtime: ref.provider,
          config: cfg,
          env: process.env,
          includeSetupRegistry: true,
        }) ?? ref.provider;
      return {
        runner: "cli",
        ...ref,
        modelRef,
        config: cfg,
        agentId: "openclaw",
        routeAgentId,
        persistModelRef: `${persistProvider}/${ref.model}`,
      };
    }
    case "gemini-cli": {
      const modelRef = resolveRouteModelRef(GEMINI_CLI_DEFAULT_MODEL_REF);
      if (typeof modelRef !== "string") {
        return modelRef;
      }
      const ref = parseRef(modelRef);
      return {
        runner: "cli",
        ...ref,
        modelRef,
        config: cfg,
        agentId: "openclaw",
        routeAgentId,
        persistModelRef: modelRef,
      };
    }
    case "codex-cli": {
      const modelRef = resolveRouteModelRef(CODEX_APP_SERVER_DEFAULT_MODEL_REF);
      if (typeof modelRef !== "string") {
        return modelRef;
      }
      const ref = parseRef(modelRef);
      if (params.codexCliApiKey) {
        const preparedAuth = prepareManualAuthForActivation({
          baseConfig: cfg,
          preparedConfig: cfg,
          profiles: [
            {
              profileId: "openai:codex-cli-api-key",
              credential: params.codexCliApiKey,
            },
          ],
          selectedProfileId: "openai:codex-cli-api-key",
          modelRef,
          targetModelRef: modelRef,
          providerId: ref.provider,
          agentId: routeAgentId,
        });
        return {
          runner: "embedded",
          ...ref,
          modelRef,
          agentHarnessRuntimeOverride: "codex",
          config: preparedAuth.config,
          agentId: "openclaw",
          routeAgentId,
          agentDir: params.agentDir,
          cleanupBundleMcpOnRunEnd: true,
          authProfileId: preparedAuth.selectedProfileId,
          persistModelRef: modelRef,
          manualAuth: {
            profiles: preparedAuth.profiles,
            runtimeConfigBase: cfg,
            sourceConfigBase: params.sourceCfg,
            configPatch: createMergePatch(cfg, preparedAuth.config),
          },
        };
      }
      return {
        runner: "embedded",
        ...ref,
        modelRef,
        agentHarnessRuntimeOverride: "codex",
        config: cfg,
        agentId: "openclaw",
        routeAgentId,
        agentDir: params.agentDir,
        cleanupBundleMcpOnRunEnd: true,
        persistModelRef: modelRef,
      };
    }
    case "openai-api-key": {
      const modelRef = resolveRouteModelRef(OPENAI_API_DEFAULT_MODEL_REF);
      if (typeof modelRef !== "string") {
        return modelRef;
      }
      const ref = parseRef(modelRef);
      return {
        runner: "embedded",
        ...ref,
        modelRef,
        config: cfg,
        agentId: "openclaw",
        routeAgentId,
        persistModelRef: modelRef,
      };
    }
    case "anthropic-api-key": {
      const modelRef = resolveRouteModelRef(ANTHROPIC_API_DEFAULT_MODEL_REF);
      if (typeof modelRef !== "string") {
        return modelRef;
      }
      const ref = parseRef(modelRef);
      return {
        runner: "embedded",
        ...ref,
        modelRef,
        config: cfg,
        agentId: "openclaw",
        routeAgentId,
        persistModelRef: modelRef,
      };
    }
    case "api-key":
    case "provider-auth": {
      const interactive = kind === "provider-auth";
      const apiKey = params.apiKey?.trim();
      if (!interactive && !apiKey) {
        return { error: "Enter an API key or token first." };
      }
      const authChoice = params.authChoice?.trim();
      if (interactive && authChoice === "custom-api-key") {
        if (!params.prompter) {
          return { error: "Custom provider setup requires an interactive setup session." };
        }
        const { promptCustomApiConfig } = await import("../commands/onboard-custom.js");
        throwIfSetupInferenceCancelled(params);
        const reservedProviderIds = params.isRemoteProviderAuth
          ? readSetupProviderNamespaces(
              cfg,
              routeAgentId,
              params.deps.loadPersistedAuthProfileStore,
            )
          : undefined;
        const prepared = await waitForProviderAuth(
          promptCustomApiConfig({
            config: cfg,
            runtime: params.runtime,
            prompter: params.prompter,
            explicitCredentials: params.isRemoteProviderAuth,
            reservedProviderIds,
            signal: params.signal,
            target: {
              agentId: routeAgentId,
              agentDir: params.agentDir,
              workspaceDir: params.pluginWorkspaceDir,
            },
            // Endpoint verification prepares config; only the real completion may select it.
            setAsPrimary: false,
          }),
          params.signal,
        );
        throwIfSetupInferenceCancelled(params);
        const profiles: ProviderAuthResult["profiles"] = [];
        if (params.isRemoteProviderAuth) {
          const providerConfig = prepared.config.models?.providers?.[prepared.providerId];
          const key = providerConfig?.apiKey;
          if (!providerConfig || typeof key !== "string" || !key.trim()) {
            return { error: "Custom setup requires an explicitly entered API key." };
          }
          // Pin the exact entered credential for the real completion. Config-only
          // keys otherwise allow ambient auth profiles to win during runtime resolution.
          profiles.push({
            profileId: `${prepared.providerId}:custom-setup`,
            credential: { type: "api_key", provider: prepared.providerId, key },
          });
          delete providerConfig.apiKey;
        }
        return buildPreparedProviderTestPlan({
          ...params,
          preparedConfig: prepared.config,
          profiles,
          selectedProfileId: profiles[0]?.profileId,
          bindProviderCredential: params.isRemoteProviderAuth,
          modelRef: `${prepared.providerId}/${prepared.modelId}`,
          routeAgentId,
        });
      }
      const choice = authChoice
        ? ((params.deps.resolveManifestProviderAuthChoice ?? resolveManifestProviderAuthChoice)(
            authChoice,
            {
              config: cfg,
              workspaceDir: params.pluginWorkspaceDir,
              includeUntrustedWorkspacePlugins: false,
              includeWorkspacePlugins: false,
            },
          ) ??
          (params.deps.resolveProviderInstallCatalogEntry ?? resolveProviderInstallCatalogEntry)(
            authChoice,
            {
              config: cfg,
              workspaceDir: params.pluginWorkspaceDir,
              includeUntrustedWorkspacePlugins: false,
              includeWorkspacePlugins: false,
            },
          ))
        : undefined;
      if (
        !choice ||
        !supportsSetupTextInference(choice.onboardingScopes) ||
        (!interactive && !supportsSetupManualSecret(choice)) ||
        (interactive &&
          (choice.assistantVisibility === "manual-only" ||
            (!choice.appGuidedAuth && choice.appGuidedDiscovery !== true)))
      ) {
        return {
          error: interactive
            ? "That provider setup is not available on this Gateway."
            : "That key-based provider is not available on this Gateway.",
        };
      }
      const providerChoice = await prepareSetupProviderAuthChoice(params, choice);
      if (providerChoice.error !== undefined) {
        return { error: providerChoice.error };
      }
      const {
        enableResult,
        baseEnableResult,
        sourceEnableResult,
        provider,
        method,
        installationPlugins,
      } = providerChoice;
      const resolved = provider && method ? { provider, method } : null;
      if (
        !resolved ||
        !supportsSetupTextInference(resolved.method.wizard?.onboardingScopes) ||
        (interactive &&
          choice.appGuidedDiscovery !== true &&
          resolved.method.kind !== "oauth" &&
          resolved.method.kind !== "device_code")
      ) {
        return {
          error: interactive
            ? "That provider setup is not available on this Gateway."
            : "That key-based provider is not available on this Gateway.",
        };
      }
      let result: ProviderAuthResult;
      let preparedConfig: OpenClawConfig;
      try {
        if (interactive) {
          if (!params.prompter) {
            return { error: "This provider login requires an interactive setup session." };
          }
          throwIfSetupInferenceCancelled(params);
          result = await waitForProviderAuth(
            runProviderPluginAuthMethodUnpersisted({
              config: enableResult.config,
              runtime: params.runtime,
              ...(params.signal ? { signal: params.signal } : {}),
              isRemote: params.isRemoteProviderAuth,
              prompter: params.prompter,
              method: resolved.method,
              agentDir: params.agentDir,
              workspaceDir,
            }),
            params.signal,
          );
          throwIfSetupInferenceCancelled(params);
          preparedConfig = applyProviderPluginAuthMethodResultConfig({
            config: enableResult.config,
            result,
          });
          if (choice.appGuidedDiscovery === true) {
            const guidedSetup = resolved.method.appGuidedSetup;
            if (!guidedSetup) {
              return { error: "That provider setup is not available on this Gateway." };
            }
            const selectedModelRef = result.defaultModel
              ? normalizeAgentModelRefForConfig(result.defaultModel)
              : "";
            const candidate = selectedModelRef
              ? { modelRef: selectedModelRef }
              : await guidedSetup.detect({
                  config: preparedConfig,
                  env: process.env,
                  workspaceDir: params.pluginWorkspaceDir,
                  ...(params.signal ? { signal: params.signal } : {}),
                });
            if (!candidate) {
              return {
                error: `${resolved.provider.label} setup completed, but no compatible model was found. Add a compatible model and try again.`,
              };
            }
            const prepared = await guidedSetup.prepare({
              config: preparedConfig,
              env: process.env,
              workspaceDir: params.pluginWorkspaceDir,
              modelRef: candidate.modelRef,
              ...(params.signal ? { signal: params.signal } : {}),
            });
            const preparedModelRef = prepared?.defaultModel
              ? normalizeAgentModelRefForConfig(prepared.defaultModel)
              : "";
            if (!prepared || preparedModelRef !== candidate.modelRef) {
              return {
                error: `${resolved.provider.label} could not prepare its detected model. Try setup again.`,
              };
            }
            preparedConfig = applyProviderPluginAuthMethodResultConfig({
              config: preparedConfig,
              result: prepared,
            });
            const profiles = new Map(
              [...result.profiles, ...prepared.profiles].map((profile) => [
                profile.profileId,
                profile,
              ]),
            );
            result = { ...prepared, profiles: [...profiles.values()] };
          }
        } else if (resolved.method.kind === "api_key" || resolved.method.kind === "token") {
          result = await runProviderPluginAuthMethodUnpersisted({
            config: enableResult.config,
            runtime: params.runtime,
            prompter: createQuickstartNotePrompter(params.runtime),
            signal: params.signal,
            assertCurrent: () => throwIfSetupInferenceCancelled(params),
            method: resolved.method,
            agentDir: params.agentDir,
            workspaceDir,
            secretInputMode: "plaintext",
            allowSecretRefPrompt: false,
            opts: { token: apiKey!, tokenProvider: resolved.provider.id },
          });
          preparedConfig = applyProviderPluginAuthMethodResultConfig({
            config: enableResult.config,
            result,
          });
        } else {
          const prepared = await runProviderManualSecretMethod({
            config: enableResult.config,
            baseConfig: cfg,
            choice,
            method: resolved.method,
            apiKey: apiKey!,
            agentDir: params.agentDir,
            workspaceDir,
          });
          result = prepared.result;
          preparedConfig = prepared.config;
        }
      } catch (error) {
        if (error instanceof SetupInferenceCancelledError || params.signal?.aborted) {
          return { error: "Provider login was cancelled." };
        }
        const detail = error instanceof Error ? error.message : String(error);
        return {
          error: `${resolved.provider.label} could not prepare this ${interactive ? "login" : "credential"} for app-guided setup: ${detail}`,
        };
      }
      throwIfSetupInferenceCancelled(params);
      const modelRef = result.defaultModel
        ? normalizeAgentModelRefForConfig(result.defaultModel)
        : "";
      if (!modelRef) {
        return {
          error: `${resolved.provider.label} does not expose a starter model for app-guided setup.`,
        };
      }
      const ref = parseRef(modelRef);
      if (!ref.model) {
        return {
          error: `${resolved.provider.label} returned an invalid starter model.`,
        };
      }
      const matchingProfile = result.profiles.find(
        (profile) =>
          normalizeProviderId(profile.credential.provider) === normalizeProviderId(ref.provider),
      );
      if (result.profiles.length > 0 && !matchingProfile) {
        return {
          error: `${resolved.provider.label} did not return credentials for its starter model.`,
        };
      }
      return buildPreparedProviderTestPlan({
        cfg: baseEnableResult.config,
        installationPlugins,
        sourceCfg: sourceEnableResult.config,
        preparedConfig,
        profiles: result.profiles,
        selectedProfileId: matchingProfile?.profileId,
        modelRef,
        pluginId: resolved.provider.pluginId,
        ...(interactive && choice.appGuidedDiscovery === true
          ? {}
          : { providerPlugin: resolved.provider }),
        agentDir: params.agentDir,
        routeAgentId,
      });
    }
    default:
      return { error: `Unknown inference choice "${kind}".` };
  }
}
