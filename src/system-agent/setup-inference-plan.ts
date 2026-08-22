import { resolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
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
import { enablePluginInConfig } from "../plugins/enable.js";
import {
  applyProviderPluginAuthMethodResultConfig,
  runProviderPluginAuthMethodUnpersisted,
} from "../plugins/provider-auth-choice.js";
import { resolveManifestProviderAuthChoice } from "../plugins/provider-auth-choices.js";
import { resolvePluginProvidersCore } from "../plugins/providers.runtime.js";
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
  canonicalizeSetupModelRef,
  parseRef,
  prepareManualAuthForActivation,
  projectManualInferenceConfig,
} from "./setup-inference-plan-helpers.js";
import { runProviderManualSecretMethod } from "./setup-inference-plan-provider-auth.js";

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
    const enablePlugin = params.deps.enablePluginInConfig ?? enablePluginInConfig;
    const enableResult = enablePlugin(cfg, choice.pluginId);
    if (!enableResult.enabled) {
      return { error: `${choice.choiceLabel} is disabled (${enableResult.reason ?? "blocked"}).` };
    }
    const sourceEnableResult = enablePlugin(params.sourceCfg, choice.pluginId);
    if (!sourceEnableResult.enabled) {
      return {
        error: `${choice.choiceLabel} is disabled (${sourceEnableResult.reason ?? "blocked"}).`,
      };
    }
    const providers = (params.deps.resolvePluginProviders ?? resolvePluginProvidersCore)({
      config: enableResult.config,
      workspaceDir: params.pluginWorkspaceDir,
      mode: "setup",
      includeUntrustedWorkspacePlugins: false,
      onlyPluginIds: [choice.pluginId],
    });
    const provider = providers.find(
      (candidate) =>
        candidate.pluginId === choice.pluginId &&
        normalizeProviderId(candidate.id) === normalizeProviderId(choice.providerId),
    );
    const method = provider?.auth.find((candidate) => candidate.id === choice.methodId);
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
      const prepared = matchingProfile
        ? prepareManualAuthForActivation({
            baseConfig: enableResult.config,
            preparedConfig,
            profiles: result.profiles,
            selectedProfileId: matchingProfile.profileId,
            modelRef,
            providerId: ref.provider,
            pluginId: choice.pluginId,
            agentId: routeAgentId,
          })
        : {
            config: projectManualInferenceConfig({
              baseConfig: enableResult.config,
              preparedConfig,
              modelRef,
              providerId: ref.provider,
              pluginId: choice.pluginId,
              agentId: routeAgentId,
            }),
            profiles: [] as ProviderAuthResult["profiles"],
            selectedProfileId: undefined,
          };
      return {
        runner: "embedded",
        ...ref,
        modelRef,
        agentDir: params.agentDir,
        config: prepared.config,
        agentId: "openclaw",
        routeAgentId,
        ...(prepared.selectedProfileId ? { authProfileId: prepared.selectedProfileId } : {}),
        persistModelRef: modelRef,
        manualAuth: {
          profiles: prepared.profiles,
          runtimeConfigBase: enableResult.config,
          sourceConfigBase: sourceEnableResult.config,
          configPatch: createMergePatch(enableResult.config, prepared.config),
          pluginId: choice.pluginId,
        },
      };
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
      const choice = authChoice
        ? (params.deps.resolveManifestProviderAuthChoice ?? resolveManifestProviderAuthChoice)(
            authChoice,
            {
              config: cfg,
              workspaceDir: params.pluginWorkspaceDir,
              includeUntrustedWorkspacePlugins: false,
              includeWorkspacePlugins: false,
            },
          )
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
      const enablePlugin = params.deps.enablePluginInConfig ?? enablePluginInConfig;
      const enableResult = enablePlugin(cfg, choice.pluginId);
      if (!enableResult.enabled) {
        return {
          error: `${choice.choiceLabel} is disabled (${enableResult.reason ?? "blocked"}).`,
        };
      }
      const sourceEnableResult = enablePlugin(params.sourceCfg, choice.pluginId);
      if (!sourceEnableResult.enabled) {
        return {
          error: `${choice.choiceLabel} is disabled (${sourceEnableResult.reason ?? "blocked"}).`,
        };
      }
      const providers = (params.deps.resolvePluginProviders ?? resolvePluginProvidersCore)({
        config: enableResult.config,
        workspaceDir: params.pluginWorkspaceDir,
        mode: "setup",
        includeUntrustedWorkspacePlugins: false,
        onlyPluginIds: [choice.pluginId],
      });
      const provider = providers.find(
        (candidate) =>
          candidate.pluginId === choice.pluginId &&
          normalizeProviderId(candidate.id) === normalizeProviderId(choice.providerId),
      );
      const method = provider?.auth.find((candidate) => candidate.id === choice.methodId);
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
      const preparedAuth = matchingProfile
        ? prepareManualAuthForActivation({
            baseConfig: enableResult.config,
            preparedConfig,
            profiles: result.profiles,
            selectedProfileId: matchingProfile.profileId,
            modelRef,
            providerId: ref.provider,
            ...(resolved.provider.pluginId ? { pluginId: resolved.provider.pluginId } : {}),
            agentId: routeAgentId,
          })
        : {
            config: projectManualInferenceConfig({
              baseConfig: enableResult.config,
              preparedConfig,
              modelRef,
              providerId: ref.provider,
              ...(resolved.provider.pluginId ? { pluginId: resolved.provider.pluginId } : {}),
              agentId: routeAgentId,
            }),
            profiles: [] as ProviderAuthResult["profiles"],
            selectedProfileId: undefined,
          };
      return {
        runner: "embedded",
        ...ref,
        modelRef,
        agentDir: params.agentDir,
        config: preparedAuth.config,
        agentId: "openclaw",
        routeAgentId,
        ...(preparedAuth.selectedProfileId
          ? { authProfileId: preparedAuth.selectedProfileId }
          : {}),
        persistModelRef: modelRef,
        manualAuth: {
          profiles: preparedAuth.profiles,
          runtimeConfigBase: enableResult.config,
          sourceConfigBase: sourceEnableResult.config,
          configPatch: createMergePatch(enableResult.config, preparedAuth.config),
          ...(resolved.provider.pluginId ? { pluginId: resolved.provider.pluginId } : {}),
        },
      };
    }
    default:
      return { error: `Unknown inference choice "${kind}".` };
  }
}
