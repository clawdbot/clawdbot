import { normalizeOptionalAgentRuntimeId } from "../agents/agent-runtime-id.js";
import { resolveAgentEffectiveModelPrimary, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { areRuntimeModelRefsEquivalent } from "../agents/model-runtime-aliases.js";
import { resolveModelRuntimePolicy } from "../agents/model-runtime-policy.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { detectInferenceBackends } from "../commands/onboard-inference.js";
import { formatErrorMessage } from "../infra/errors.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import {
  type ProviderAuthChoiceMetadata,
  resolveManifestProviderAuthChoices,
} from "../plugins/provider-auth-choices.js";
import { resolvePluginProviders } from "../plugins/providers.runtime.js";
import { listRecommendedToolInstalls } from "../plugins/recommended-tool-installs.js";
import { probeLocalCommand } from "./probes.js";
import {
  listSetupInferenceAuthOptions,
  listSetupInferenceManualProviders,
  listSetupInferencePrepareOptions,
  supportsSetupTextInference,
} from "./setup-inference-auth-options.js";
import {
  type DetectSetupInferenceDeps,
  type SetupInferenceCandidate,
  type SetupInferenceDetection,
  type SetupInferenceUnavailableCandidate,
  invalidSetupConfigError,
  setupInferenceLog,
  resolveCandidatePresentation,
  resolveSetupInferenceWorkspace,
  toProviderAutoSetupKind,
} from "./setup-inference-core.js";
import { parseRef } from "./setup-inference-plan-helpers.js";

function resolveConfiguredCandidateKind(
  config: Parameters<typeof resolveModelRuntimePolicy>[0]["config"],
  modelRef: string | undefined,
): SetupInferenceCandidate["kind"] | undefined {
  if (!modelRef) {
    return undefined;
  }
  const ref = parseRef(modelRef);
  const runtime = normalizeOptionalAgentRuntimeId(
    resolveModelRuntimePolicy({
      config,
      provider: ref.provider,
      modelId: ref.model,
      agentId: resolveDefaultAgentId(config ?? {}),
    }).policy?.id,
  );
  if (runtime === "codex") {
    return "codex-cli";
  }
  if (runtime === "claude-cli") {
    return "claude-cli";
  }
  return undefined;
}

/**
 * Manual setup options only — no CLI probing, no credential discovery. Used
 * when guarded onboarding declines the "look around" step: the option lists
 * derive from config and plugin manifests, never from scanning the machine.
 */
export async function listManualSetupInferenceOptions(
  deps: DetectSetupInferenceDeps = {},
): Promise<
  Pick<
    SetupInferenceDetection,
    "manualProviders" | "authOptions" | "prepareOptions" | "workspace" | "setupComplete"
  >
> {
  const { readConfigFileSnapshot } = await import("../config/config.js");
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    throw new Error(invalidSetupConfigError(snapshot));
  }
  const cfg = snapshot.runtimeConfig ?? snapshot.config;
  const { workspace } = await resolveSetupInferenceWorkspace({
    configExists: snapshot.exists,
    configValid: snapshot.valid,
  });
  const authChoices = (
    deps.resolveManifestProviderAuthChoices ?? resolveManifestProviderAuthChoices
  )({
    config: cfg,
    workspaceDir: workspace,
    includeUntrustedWorkspacePlugins: false,
    includeWorkspacePlugins: false,
  }).filter(
    (choice) => (deps.enablePluginInConfig ?? enablePluginInConfig)(cfg, choice.pluginId).enabled,
  );
  return {
    manualProviders: listSetupInferenceManualProviders(authChoices),
    authOptions: listSetupInferenceAuthOptions(authChoices),
    prepareOptions: listSetupInferencePrepareOptions(authChoices),
    workspace,
    // Derived from config only (no probing): a pre-existing default model must
    // keep classifying the install as configured even when scanning declined.
    setupComplete: Boolean(resolveAgentEffectiveModelPrimary(cfg, resolveDefaultAgentId(cfg))),
  };
}

export async function detectSetupInference(
  deps: DetectSetupInferenceDeps = {},
): Promise<SetupInferenceDetection> {
  const { readConfigFileSnapshot } = await import("../config/config.js");
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    throw new Error(invalidSetupConfigError(snapshot));
  }
  const cfg = snapshot.runtimeConfig ?? snapshot.config;
  const detected = await (deps.detectInferenceBackends ?? detectInferenceBackends)({ config: cfg });
  const unavailableCandidates: SetupInferenceUnavailableCandidate[] = [];
  const deferredUnavailableCandidates: SetupInferenceUnavailableCandidate[] = [];
  const probe = deps.probeLocalCommand ?? probeLocalCommand;
  const [pi, opencode] = await Promise.all([probe("pi"), probe("opencode")]);
  if (pi.found && !pi.timedOut) {
    deferredUnavailableCandidates.push({
      id: "pi-cli",
      label: "Pi CLI",
      detail: "installed",
      reason:
        "Pi CLI is installed, but its whole-agent sessions require separate setup and are not a reusable guided-setup inference route.",
    });
  }
  if (opencode.found && !opencode.timedOut) {
    deferredUnavailableCandidates.push({
      id: "opencode-cli",
      label: "OpenCode CLI",
      detail: "installed",
      reason:
        "OpenCode CLI is installed, but its ACP harness requires separate setup and is not a reusable guided-setup inference route.",
    });
  }
  const configuredModel = detected.find(
    (candidate) => candidate.kind === "existing-model",
  )?.modelRef;
  const configuredCandidateKind = resolveConfiguredCandidateKind(cfg, configuredModel);
  const raw = detected.filter(
    (candidate) =>
      candidate.kind !== "gemini-cli" &&
      !(
        candidate.kind === configuredCandidateKind &&
        configuredModel &&
        areRuntimeModelRefsEquivalent(candidate.modelRef, configuredModel, { config: cfg })
      ),
  );
  const { workspace } = await resolveSetupInferenceWorkspace({
    configExists: snapshot.exists,
    configValid: snapshot.valid,
  });
  const authChoices = (
    deps.resolveManifestProviderAuthChoices ?? resolveManifestProviderAuthChoices
  )({
    config: cfg,
    workspaceDir: workspace,
    includeUntrustedWorkspacePlugins: false,
    includeWorkspacePlugins: false,
  }).filter(
    (choice) => (deps.enablePluginInConfig ?? enablePluginInConfig)(cfg, choice.pluginId).enabled,
  );
  const manualProviders = listSetupInferenceManualProviders(authChoices);
  const authOptions = listSetupInferenceAuthOptions(authChoices);
  const prepareOptions = listSetupInferencePrepareOptions(authChoices);
  unavailableCandidates.push(...deferredUnavailableCandidates);
  const candidates: SetupInferenceCandidate[] = raw.map((candidate) =>
    // Released macOS clients require this field. Keep it false so the wire
    // contract remains decodable without expressing a provider preference.
    Object.assign(
      candidate,
      { recommended: false as const },
      resolveCandidatePresentation(candidate, authChoices),
    ),
  );
  const discoveryChoices = authChoices.filter(
    (choice) =>
      choice.appGuidedDiscovery === true && supportsSetupTextInference(choice.onboardingScopes),
  );
  if (discoveryChoices.length > 0) {
    let discoveryConfig = cfg;
    const enabledChoices: ProviderAuthChoiceMetadata[] = [];
    for (const choice of discoveryChoices) {
      const enabled = (deps.enablePluginInConfig ?? enablePluginInConfig)(
        discoveryConfig,
        choice.pluginId,
      );
      if (!enabled.enabled) {
        continue;
      }
      discoveryConfig = enabled.config;
      enabledChoices.push(choice);
    }
    const providers = (deps.resolvePluginProviders ?? resolvePluginProviders)({
      config: discoveryConfig,
      workspaceDir: workspace,
      mode: "setup",
      includeUntrustedWorkspacePlugins: false,
      onlyPluginIds: [...new Set(enabledChoices.map((choice) => choice.pluginId))],
    });
    const discovered = await Promise.all(
      enabledChoices.map(async (choice): Promise<SetupInferenceCandidate | null> => {
        const provider = providers.find(
          (candidate) =>
            candidate.pluginId === choice.pluginId &&
            normalizeProviderId(candidate.id) === normalizeProviderId(choice.providerId),
        );
        const method = provider?.auth.find((candidate) => candidate.id === choice.methodId);
        if (!method?.appGuidedSetup) {
          return null;
        }
        try {
          const candidate = await method.appGuidedSetup.detect({
            config: discoveryConfig,
            env: process.env,
            workspaceDir: workspace,
          });
          if (!candidate) {
            return null;
          }
          const ref = parseRef(candidate.modelRef);
          if (
            !ref.model ||
            normalizeProviderId(ref.provider) !== normalizeProviderId(choice.providerId)
          ) {
            setupInferenceLog.warn(
              `Ignoring invalid app-guided model ${candidate.modelRef} from ${choice.choiceId}.`,
            );
            return null;
          }
          return Object.assign(
            {
              kind: toProviderAutoSetupKind(choice.choiceId),
              brandId: choice.providerId,
              label: choice.choiceLabel,
              detail: candidate.detail?.trim() || "available locally",
              modelRef: candidate.modelRef,
              recommended: false as const,
              credentials: true,
            },
            choice.icon ? { icon: choice.icon } : {},
            choice.website ? { website: choice.website } : {},
          );
        } catch (error) {
          setupInferenceLog.debug(
            `App-guided discovery failed for ${choice.choiceId}: ${formatErrorMessage(error)}`,
          );
          return null;
        }
      }),
    );
    candidates.push(...discovered.filter((candidate) => candidate !== null));
  }
  return {
    candidates,
    unavailableCandidates,
    manualProviders,
    authOptions,
    prepareOptions,
    recommendedInstalls: listRecommendedToolInstalls(),
    workspace,
    ...(configuredModel ? { configuredModel } : {}),
    setupComplete: Boolean(configuredModel),
  };
}
