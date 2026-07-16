import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import { isProfileInCooldown } from "../../auth-profiles.js";
import type { ResolvedProviderAuth } from "../../model-auth.js";
import {
  hasPreparedAuthAttemptModelMetadata,
  resolveCredentialScopedAuthAttemptModelDecision,
} from "../../runtime-plan/credential-scoped-model.js";
import {
  canRunPreparedAgentRuntimeAuthAttempt,
  type PreparedAgentRuntimeAuthAttempt,
} from "../../runtime-plan/prepare-auth.js";
import type { AgentRuntimeAuthPlan } from "../../runtime-plan/types.js";
import { resolveCandidateThinkingLevel } from "../../thinking-runtime.js";
import { log } from "../logger.js";
import {
  createEmbeddedRunStageTracker,
  formatEmbeddedRunStageSummary,
} from "./attempt-stage-timing.js";
import {
  createEmbeddedRunAuthController,
  resolveEmbeddedAuthCooldownProbePolicy,
} from "./auth-controller.js";
import { prepareEmbeddedRunAuthPlan } from "./auth-plan.js";
import { createScopedAuthProfileStore } from "./auth-store.js";
import type { RuntimeAuthState } from "./helpers.js";
import {
  resolveEmbeddedRunEffectiveModel,
  selectEmbeddedRunHarness,
  selectEmbeddedRunHarnessForPreparedAttempts,
} from "./model-harness.js";
import { resolveEmbeddedRunModelSetup } from "./model-setup.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { resolveInitialThinkLevel } from "./runtime-resolution.js";

type ApiKeyInfo = ResolvedProviderAuth;

export async function prepareEmbeddedRunRuntime(input: {
  runParams: RunEmbeddedAgentParams;
  provider: string;
  modelId: string;
  agentDir: string;
  workspaceDir: string;
  globalLane: string;
  hookRunner: Parameters<typeof resolveEmbeddedRunModelSetup>[0]["hookRunner"];
  hookContext: Parameters<typeof resolveEmbeddedRunModelSetup>[0]["hookContext"];
  markStartupStage: (stage: string) => void;
  notifyExecutionPhase: (
    phase: Parameters<NonNullable<RunEmbeddedAgentParams["onExecutionPhase"]>>[0]["phase"],
    context?: Omit<Parameters<NonNullable<RunEmbeddedAgentParams["onExecutionPhase"]>>[0], "phase">,
  ) => void;
  fallbackConfigured: boolean;
}) {
  const params = input.runParams;
  let provider = input.provider;
  let modelId = input.modelId;
  const modelSetup = await resolveEmbeddedRunModelSetup({
    runParams: params,
    provider,
    modelId,
    agentDir: input.agentDir,
    workspaceDir: input.workspaceDir,
    globalLane: input.globalLane,
    hookRunner: input.hookRunner,
    hookContext: input.hookContext,
    onHooksResolved: () => input.markStartupStage("hooks"),
  });
  provider = modelSetup.provider;
  modelId = modelSetup.modelId;
  const {
    requestedModelId,
    modelSelectionChangedByHook,
    beforeAgentStartResult,
    requestStreamTransportOverrides,
    expectedHarnessArtifact,
    nativeModelOwnedHarnessId,
    nativeModelOwned,
    modelConfigProvider,
    model,
    authStorage,
    modelRegistry,
  } = modelSetup;
  let agentHarness = modelSetup.agentHarness;
  let pluginHarnessOwnsTransport = modelSetup.pluginHarnessOwnsTransport;
  let runtimeModel = model;
  const resolveEffectiveModel = (candidate: typeof runtimeModel) =>
    resolveEmbeddedRunEffectiveModel({
      runParams: params,
      provider,
      modelConfigProvider,
      modelId,
      agentHarnessId: agentHarness.id,
      runtimeModel: candidate,
      nativeModelOwned,
      requestStreamTransportOverrides,
      nativeModelOwnedHarnessId,
    });
  const initialResolvedRuntimeModel = resolveEffectiveModel(runtimeModel);
  let contextTokenBudget = initialResolvedRuntimeModel.contextTokenBudget;
  let contextWindowInfo = initialResolvedRuntimeModel.contextWindowInfo;
  let outerContextTokenMeta: { contextTokens?: number } =
    contextTokenBudget === undefined ? {} : { contextTokens: contextTokenBudget };
  let effectiveModel = initialResolvedRuntimeModel.effectiveModel;
  const applyResolvedRuntimeModel = (
    candidate: typeof runtimeModel,
    resolved = resolveEffectiveModel(candidate),
  ) => {
    runtimeModel = candidate;
    effectiveModel = resolved.effectiveModel;
    contextTokenBudget = resolved.contextTokenBudget;
    contextWindowInfo = resolved.contextWindowInfo;
    outerContextTokenMeta =
      contextTokenBudget === undefined ? {} : { contextTokens: contextTokenBudget };
  };
  const selectHarnessForModel = (
    candidate: typeof effectiveModel,
    plan?: AgentRuntimeAuthPlan,
    preparedAuthAttempt?: PreparedAgentRuntimeAuthAttempt,
  ) =>
    selectEmbeddedRunHarness({
      runParams: params,
      provider,
      modelId,
      model: candidate,
      plan,
      preparedAuthAttempt,
      requestStreamTransportOverrides,
      nativeModelOwnedHarnessId,
    });
  const selectHarnessForPreparedAttempts = (
    candidate: typeof effectiveModel,
    attempts: readonly PreparedAgentRuntimeAuthAttempt[],
  ) =>
    selectEmbeddedRunHarnessForPreparedAttempts({
      runParams: params,
      provider,
      modelId,
      model: candidate,
      attempts,
      requestStreamTransportOverrides,
      nativeModelOwnedHarnessId,
    });
  input.markStartupStage("model-resolution");
  input.notifyExecutionPhase("model_resolution", { provider, model: modelId });

  agentHarness = selectHarnessForModel(effectiveModel);
  pluginHarnessOwnsTransport = agentHarness.id !== "openclaw";
  const authStages = log.isEnabled("trace") ? createEmbeddedRunStageTracker() : undefined;
  const preparedAuthPlan = await prepareEmbeddedRunAuthPlan({
    runParams: params,
    provider,
    modelId,
    model,
    agentDir: input.agentDir,
    workspaceDir: input.workspaceDir,
    requestStreamTransportOverrides,
    nativeModelOwned,
    authStorage,
    modelRegistry,
    getAgentHarness: () => agentHarness,
    setAgentHarness: (nextHarness) => {
      agentHarness = nextHarness;
      pluginHarnessOwnsTransport = agentHarness.id !== "openclaw";
    },
    getRuntimeModel: () => runtimeModel,
    getEffectiveModel: () => effectiveModel,
    applyResolvedRuntimeModel,
    selectHarnessForPreparedAttempts,
    markStage: (stage) => authStages?.mark(stage),
  });
  const {
    usesOpenAIAuthRouting,
    attemptAuthProfileStore,
    lockedProfileId,
    preferredProfileId,
    providerUsesProfileScopedModelMetadata,
    materializeAuthPlan,
    materializeAuthPlanUncached,
    preparedAuthAttempts,
  } = preparedAuthPlan;
  let { activePreparedAuthPlan } = preparedAuthPlan;
  const genericCompactionRecoveryAllowed = !pluginHarnessOwnsTransport;
  const profileCandidates = preparedAuthAttempts.map((attempt) => attempt.profileId);
  const forwardedPluginHarnessProfileId = pluginHarnessOwnsTransport
    ? activePreparedAuthPlan.forwardedAuthProfileId
    : undefined;
  let profileIndex = 0;
  const requestedThinkLevel = resolveInitialThinkLevel({
    requested: params.thinkLevel,
    config: params.config,
    provider,
    modelId,
    model: effectiveModel,
  });
  const initialThinkLevel = modelSelectionChangedByHook
    ? (resolveCandidateThinkingLevel({
        cfg: params.config,
        provider,
        modelId,
        level: requestedThinkLevel,
        catalog: [
          {
            provider,
            id: modelId,
            api: effectiveModel.api,
            reasoning: effectiveModel.reasoning,
            params: effectiveModel.params,
            compat: effectiveModel.compat,
          },
        ],
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        agentRuntime: agentHarness.id,
      }) ?? requestedThinkLevel)
    : requestedThinkLevel;
  let thinkLevel = initialThinkLevel;
  const attemptedThinking = new Set<ThinkLevel>();
  let apiKeyInfo: ApiKeyInfo | null = null;
  let lastProfileId: string | undefined;
  let runtimeAuthState: RuntimeAuthState | null = null;
  let runtimeAuthRefreshCancelled = false;
  const pluginHarnessOwnsAuthBootstrap =
    pluginHarnessOwnsTransport && agentHarness.authBootstrap === "harness";
  const preparedApiKeyRoute = activePreparedAuthPlan.modelRoute?.authRequirement === "api-key";
  const pluginHarnessHasPreparedApiKeyAttempt = preparedAuthAttempts.some(
    (attempt) => attempt.plan.modelRoute?.authRequirement === "api-key",
  );
  const pluginHarnessNeedsOpenClawAuthBootstrap =
    pluginHarnessOwnsTransport &&
    usesOpenAIAuthRouting &&
    (preparedApiKeyRoute ||
      (!pluginHarnessOwnsAuthBootstrap &&
        profileCandidates.some((profileId) => Boolean(profileId))));
  const findPreparedAuthAttempt = (profileId: string | undefined, attemptIndex?: number) => {
    const attempt =
      attemptIndex === undefined
        ? preparedAuthAttempts.find((candidate) => candidate.profileId === profileId)
        : preparedAuthAttempts[attemptIndex];
    return attempt?.profileId === profileId ? attempt : undefined;
  };
  let preparedProfileAttempted = false;
  const prepareAuthAttempt = async (attempt: (typeof preparedAuthAttempts)[number]) => {
    if (
      !canRunPreparedAgentRuntimeAuthAttempt({
        attempt,
        priorProfileAttempted: preparedProfileAttempted,
      })
    ) {
      throw new Error(
        `Prepared direct auth fallback cannot bypass unavailable profiles for ${provider}/${modelId}.`,
      );
    }
    const modelDecision = resolveCredentialScopedAuthAttemptModelDecision({
      attempt,
      priorProfileAttempted: preparedProfileAttempted,
      requestedProfileId: params.authProfileId,
      providerUsesProfileScopedModelMetadata,
    });
    const nextRuntimeModel = modelDecision.shouldMaterialize
      ? modelDecision.forceResolve
        ? await materializeAuthPlanUncached(attempt.plan, true)
        : await materializeAuthPlan(attempt.plan)
      : runtimeModel;
    const nextResolvedModel = resolveEffectiveModel(nextRuntimeModel);
    const nextHarness = selectHarnessForPreparedAttempts(
      nextResolvedModel.effectiveModel,
      preparedAuthAttempts,
    );
    if (nextHarness.id !== agentHarness.id) {
      throw new Error(
        `Prepared auth retry changed the selected agent harness for ${provider}/${modelId}.`,
      );
    }
    preparedProfileAttempted ||= attempt.kind === "profile";
    return {
      runtimeModel: nextRuntimeModel,
      authRequirement: modelDecision.authRequirement,
      allowAuthProfileFallback: attempt.allowAuthProfileFallback,
      commit() {
        applyResolvedRuntimeModel(nextRuntimeModel, nextResolvedModel);
        activePreparedAuthPlan = attempt.plan;
      },
    };
  };
  const hasPreparedAuthAttemptMetadata = hasPreparedAuthAttemptModelMetadata({
    attempts: preparedAuthAttempts,
    providerUsesProfileScopedModelMetadata,
  });
  const prepareModelForAuthProfile =
    hasPreparedAuthAttemptMetadata &&
    (!pluginHarnessOwnsAuthBootstrap || pluginHarnessHasPreparedApiKeyAttempt)
      ? async (profileId: string | undefined, attemptIndex?: number) => {
          const attempt = findPreparedAuthAttempt(profileId, attemptIndex);
          if (!attempt) {
            throw new Error(
              `Auth profile "${profileId ?? "(none)"}" is outside the prepared attempts for ${provider}/${modelId}.`,
            );
          }
          const prepared = await prepareAuthAttempt(attempt);
          if (attempt.plan.modelRoute && !prepared.authRequirement) {
            throw new Error(`Prepared route metadata is missing for ${provider}/${modelId}.`);
          }
          return {
            runtimeModel: prepared.runtimeModel,
            authRequirement: prepared.authRequirement,
            allowAuthProfileFallback: prepared.allowAuthProfileFallback,
            commit: () => prepared.commit(),
          };
        }
      : undefined;
  const authController = createEmbeddedRunAuthController({
    config: params.config,
    agentDir: input.agentDir,
    workspaceDir: input.workspaceDir,
    authStore: attemptAuthProfileStore,
    authStorage,
    profileCandidates,
    lockedProfileId,
    initialThinkLevel,
    attemptedThinking,
    fallbackConfigured: input.fallbackConfigured,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe === true,
    getProvider: () => provider,
    getModelId: () => modelId,
    getRuntimeModel: () => runtimeModel,
    setRuntimeModel: (next) => {
      runtimeModel = next;
    },
    getEffectiveModel: () => effectiveModel,
    setEffectiveModel: (next) => {
      effectiveModel = next;
    },
    getApiKeyInfo: () => apiKeyInfo,
    setApiKeyInfo: (next) => {
      apiKeyInfo = next;
    },
    getLastProfileId: () => lastProfileId,
    setLastProfileId: (next) => {
      lastProfileId = next;
    },
    getRuntimeAuthState: () => runtimeAuthState,
    setRuntimeAuthState: (next) => {
      runtimeAuthState = next;
    },
    getRuntimeAuthRefreshCancelled: () => runtimeAuthRefreshCancelled,
    setRuntimeAuthRefreshCancelled: (next) => {
      runtimeAuthRefreshCancelled = next;
    },
    getProfileIndex: () => profileIndex,
    setProfileIndex: (next) => {
      profileIndex = next;
    },
    ...(prepareModelForAuthProfile ? { prepareModelForAuthProfile } : {}),
    setThinkLevel: (next) => {
      thinkLevel = next;
    },
    log,
  });
  authStages?.mark("controller");
  const advancePluginHarnessAuthAttempt = async (): Promise<boolean> => {
    if (!pluginHarnessOwnsTransport || lockedProfileId) {
      return false;
    }
    let nextIndex = profileIndex + 1;
    while (nextIndex < preparedAuthAttempts.length) {
      const candidateAttempt = preparedAuthAttempts[nextIndex];
      if (!candidateAttempt) {
        nextIndex += 1;
        continue;
      }
      const candidate = candidateAttempt.profileId;
      if (
        candidate &&
        isProfileInCooldown(attemptAuthProfileStore, candidate, undefined, modelId)
      ) {
        nextIndex += 1;
        continue;
      }
      if (
        !canRunPreparedAgentRuntimeAuthAttempt({
          attempt: candidateAttempt,
          priorProfileAttempted: preparedProfileAttempted,
        })
      ) {
        return false;
      }
      if (candidateAttempt.plan.modelRoute?.authRequirement === "api-key") {
        try {
          await authController.applyAuthProfileCandidate(candidate, nextIndex);
          profileIndex = nextIndex;
          thinkLevel = initialThinkLevel;
          attemptedThinking.clear();
          return true;
        } catch {
          nextIndex += 1;
          continue;
        }
      }
      if (!candidate || candidateAttempt.plan.forwardedAuthProfileId !== candidate) {
        nextIndex += 1;
        continue;
      }
      const prepared = await prepareAuthAttempt(candidateAttempt);
      authController.stopRuntimeAuthRefreshTimer();
      apiKeyInfo = null;
      runtimeAuthState = null;
      prepared.commit();
      profileIndex = nextIndex;
      lastProfileId = candidate;
      thinkLevel = initialThinkLevel;
      attemptedThinking.clear();
      return true;
    }
    return false;
  };
  const advanceAttemptAuthProfile = pluginHarnessOwnsAuthBootstrap
    ? advancePluginHarnessAuthAttempt
    : authController.advanceAuthProfile;

  if (!pluginHarnessOwnsTransport || pluginHarnessNeedsOpenClawAuthBootstrap) {
    await authController.initializeAuthProfile();
  } else if (lockedProfileId) {
    lastProfileId = lockedProfileId;
  } else if (forwardedPluginHarnessProfileId) {
    const initialAttempt = preparedAuthAttempts[profileIndex];
    const initialProfileInCooldown =
      initialAttempt?.kind === "profile" &&
      isProfileInCooldown(attemptAuthProfileStore, initialAttempt.profileId, undefined, modelId);
    const cooldownProbePolicy = resolveEmbeddedAuthCooldownProbePolicy({
      authStore: attemptAuthProfileStore,
      profileCandidates,
      lockedProfileId,
      modelId,
      allowTransientCooldownProbe: params.allowTransientCooldownProbe === true,
    });
    if (initialProfileInCooldown && !cooldownProbePolicy.allowProbe) {
      if (!(await advancePluginHarnessAuthAttempt())) {
        throw new Error(
          `Prepared auth profiles are temporarily unavailable for ${provider}/${modelId}.`,
        );
      }
    } else {
      if (initialProfileInCooldown) {
        log.warn(
          `probing cooldowned auth profile for ${provider}/${modelId} due to ${cooldownProbePolicy.unavailableReason ?? "transient"} unavailability`,
        );
      }
      preparedProfileAttempted = initialAttempt?.kind === "profile";
      lastProfileId = forwardedPluginHarnessProfileId;
    }
  }
  authStages?.mark("initialize");
  if (authStages) {
    log.trace(
      formatEmbeddedRunStageSummary(
        `[trace:embedded-run] auth stages: runId=${params.runId} sessionId=${params.sessionId} phase=auth`,
        authStages.snapshot(),
      ),
    );
  }
  input.markStartupStage("auth");
  input.notifyExecutionPhase("auth", { provider, model: modelId });

  return {
    provider,
    modelId,
    requestedModelId,
    beforeAgentStartResult,
    expectedHarnessArtifact,
    nativeModelOwned,
    model,
    authStorage,
    modelRegistry,
    attemptAuthProfileStore,
    lockedProfileId,
    preferredProfileId,
    profileCandidates,
    profileFailureStore: attemptAuthProfileStore,
    genericCompactionRecoveryAllowed,
    pluginHarnessOwnsAuthBootstrap,
    attemptedThinking,
    advanceAttemptAuthProfile,
    maybeRefreshRuntimeAuthForAuthError: authController.maybeRefreshRuntimeAuthForAuthError,
    stopRuntimeAuthRefreshTimer: authController.stopRuntimeAuthRefreshTimer,
    getApiKeyInfo: () => apiKeyInfo,
    setThinkLevel: (next: ThinkLevel) => {
      thinkLevel = next;
    },
    resolveRunAttemptAuthProfileStore: (): AuthProfileStore => {
      if (!pluginHarnessOwnsTransport) {
        return attemptAuthProfileStore;
      }
      const activeProfileIds = activePreparedAuthPlan.modelRoute
        ? [
            activePreparedAuthPlan.forwardedAuthProfileId,
            ...(activePreparedAuthPlan.forwardedAuthProfileCandidateIds ?? []),
          ]
        : [lastProfileId];
      return createScopedAuthProfileStore(
        attemptAuthProfileStore,
        activeProfileIds.filter((profileId): profileId is string => Boolean(profileId)),
      );
    },
    snapshot: () => ({
      agentHarness,
      pluginHarnessOwnsTransport,
      effectiveModel,
      contextTokenBudget,
      contextWindowInfo,
      outerContextTokenMeta,
      activePreparedAuthPlan,
      thinkLevel,
      apiKeyInfo,
      lastProfileId,
      runtimeAuthState,
    }),
  };
}
