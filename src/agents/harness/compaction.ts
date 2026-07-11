import type { Model } from "openclaw/plugin-sdk/llm";
/**
 * Routes compaction through selected native agent harnesses when supported.
 */
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import { isDefaultAgentRuntimeId, normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import { resolveAgentDir, resolveSessionAgentIds } from "../agent-scope.js";
import type { CompactEmbeddedAgentSessionParams } from "../embedded-agent-runner/compact.types.js";
import { resolveModelAsync } from "../embedded-agent-runner/model.js";
import type { EmbeddedAgentCompactResult } from "../embedded-agent-runner/types.js";
import {
  applySecretRefHeaderSentinels,
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
} from "../model-auth.js";
import { isCliRuntimeAliasForProvider, isCliRuntimeProvider } from "../model-runtime-aliases.js";
import { isOpenAIProvider } from "../openai-routing.js";
import {
  unwrapModelHeaderSentinelsForProviderEgress,
  unwrapSecretSentinelsForProviderEgress,
} from "../provider-secret-egress.js";
import { materializePreparedRuntimeModel } from "../runtime-plan/materialize-model.js";
import {
  agentRuntimeAuthPlanMatchesTarget,
  prepareAgentRuntimeAuth,
  type PreparedAgentRuntimeAuth,
  type PreparedAgentRuntimeAuthAttempt,
} from "../runtime-plan/prepare-auth.js";
import {
  resolvePreparedRuntimeAuthAttempts,
  resolvePreparedRuntimeModelAuth,
} from "../runtime-plan/resolve-auth.js";
import type { AgentRuntimeAuthPlan } from "../runtime-plan/types.js";
import { resolveAgentHarnessPolicy as resolveConfiguredAgentHarnessPolicy } from "./policy.js";
import {
  selectAgentHarness,
  selectAgentHarnessForPreparedModelProviders,
  type AgentHarnessPreparedModelProvider,
} from "./selection.js";
import {
  resolveAgentHarnessPreparedAuthSupport,
  resolveAgentHarnessPreparedRouteSupport,
} from "./support.js";
import type {
  AgentHarness,
  AgentHarnessCompactParams,
  AgentHarnessCompactResult,
} from "./types.js";

/**
 * Delegates session compaction to the selected agent harness when that runtime owns compaction.
 *
 * CLI runtimes and OpenClaw-native compaction stay on the embedded runner path; plugin harnesses
 * can opt in through their `compact` hook.
 */
type NativeCompactionRequest = "after_context_engine";

type InternalAgentHarnessCompactionOptions = {
  nativeCompactionRequest?: NativeCompactionRequest;
};

type InternalAgentHarnessCompactionCapability = {
  // Context-engine follow-up compaction is core/Codex sequencing, not a plugin SDK
  // contract. Keep it behind this private capability so public compact params stay generic.
  compactAfterContextEngine?(
    params: AgentHarnessCompactParams,
  ): Promise<AgentHarnessCompactResult | undefined>;
};

type InternalAgentHarness = AgentHarness & InternalAgentHarnessCompactionCapability;
type HarnessCompactionResolvedAuth = { apiKey?: string };

function runtimePlanRequiresHostApiKey(plan?: AgentRuntimeAuthPlan): boolean {
  return plan?.modelRoute?.authRequirement === "api-key";
}

function resolveHarnessCompactIdentity(params: CompactEmbeddedAgentSessionParams): {
  agentDir: string;
  agentId: string;
} {
  const agentIds = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  return {
    agentDir: params.agentDir ?? resolveAgentDir(params.config ?? {}, agentIds.sessionAgentId),
    agentId: params.agentId ?? agentIds.sessionAgentId,
  };
}

function stripHarnessOwnedAuthInputs(
  params: CompactEmbeddedAgentSessionParams,
): CompactEmbeddedAgentSessionParams {
  const result = { ...params };
  delete result.resolvedApiKey;
  delete result.runtimeModel;
  return result;
}

function buildHarnessCompactionModelProvider(params: {
  model?: Model;
  plan?: AgentRuntimeAuthPlan;
  attempt?: PreparedAgentRuntimeAuthAttempt;
}): AgentHarnessPreparedModelProvider {
  const route = params.plan?.modelRoute;
  return {
    api: route?.api ?? params.model?.api,
    baseUrl: route?.baseUrl ?? params.model?.baseUrl,
    ...resolveAgentHarnessPreparedRouteSupport(params.plan),
    ...(params.plan
      ? {
          preparedAuth: resolveAgentHarnessPreparedAuthSupport({
            plan: params.plan,
            source: params.attempt?.kind === "implicit" ? undefined : params.attempt?.kind,
          }),
        }
      : {}),
  };
}

async function resolveHarnessCompactApiKey(params: {
  agentDir: string;
  compactParams: CompactEmbeddedAgentSessionParams;
  initialHarness: AgentHarness;
  agentId: string;
  sessionKey?: string;
  pinnedHarnessId?: string;
}): Promise<{
  harness: AgentHarness;
  apiKey?: string;
  runtimeModel?: Model;
  runtimeAuthPlan?: AgentRuntimeAuthPlan;
}> {
  const { agentDir, compactParams, initialHarness } = params;
  if (!compactParams.provider?.trim() || !compactParams.model?.trim()) {
    const existing = compactParams.resolvedApiKey?.trim();
    return existing ? { harness: initialHarness, apiKey: existing } : { harness: initialHarness };
  }
  const provider = compactParams.provider;
  const modelId = compactParams.model;
  const providedRuntimeAuthPlan = compactParams.runtimeAuthPlan ?? compactParams.runtimePlan?.auth;
  const reusableRuntimeAuthPlan =
    providedRuntimeAuthPlan &&
    agentRuntimeAuthPlanMatchesTarget(providedRuntimeAuthPlan, { provider, modelId })
      ? providedRuntimeAuthPlan
      : undefined;
  const workspaceDir = resolveUserPath(compactParams.workspaceDir);
  const callerRuntimeModel = compactParams.runtimeModel;
  const fallbackResolution = (
    harness: AgentHarness,
    runtimeModel?: Model,
    runtimeAuthPlan?: AgentRuntimeAuthPlan,
  ) => {
    if (harness.authBootstrap === "harness" && !runtimeAuthPlan) {
      throw new Error(
        `Unable to prepare a route-locked native compaction attempt for ${provider}/${modelId}; refusing harness-owned ambient auth.`,
      );
    }
    const apiKey = compactParams.resolvedApiKey?.trim() || undefined;
    return {
      harness,
      ...(apiKey ? { apiKey } : {}),
      ...(runtimeModel ? { runtimeModel } : {}),
      ...(runtimeAuthPlan ? { runtimeAuthPlan } : {}),
    };
  };
  const selectPreparedHarness = (
    attempts: readonly PreparedAgentRuntimeAuthAttempt[],
    preparedModel?: Model,
  ) =>
    selectAgentHarnessForPreparedModelProviders({
      provider,
      modelId,
      modelProviders: attempts.map((attempt) =>
        buildHarnessCompactionModelProvider({
          model: preparedModel,
          plan: attempt.plan,
          attempt,
        }),
      ),
      config: compactParams.config,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      agentHarnessId: params.pinnedHarnessId,
    });
  if (reusableRuntimeAuthPlan) {
    const reusableAttempts = [{ kind: "implicit" as const, plan: reusableRuntimeAuthPlan }];
    const reusableHarness = selectPreparedHarness(reusableAttempts, callerRuntimeModel);
    if (
      (reusableHarness.authBootstrap === "harness" ||
        reusableRuntimeAuthPlan.harnessAuthProvider) &&
      !runtimePlanRequiresHostApiKey(reusableRuntimeAuthPlan)
    ) {
      return fallbackResolution(reusableHarness, callerRuntimeModel, reusableRuntimeAuthPlan);
    }
  }
  const resolvePreparedModel = ({
    config,
    authProfileId: profileId,
    authProfileMode,
  }: Parameters<Parameters<typeof materializePreparedRuntimeModel<Model>>[0]["resolveModel"]>[0]) =>
    resolveModelAsync(provider, modelId, agentDir, config, {
      authProfileId: profileId,
      authProfileMode,
      skipAgentDiscovery: true,
      allowBundledStaticCatalogFallback: true,
      preferBundledStaticCatalogTransport: true,
      workspaceDir,
    });
  let model = callerRuntimeModel;
  if (!model) {
    try {
      model = (
        await resolveModelAsync(provider, modelId, agentDir, compactParams.config, {
          authProfileId:
            reusableRuntimeAuthPlan?.forwardedAuthProfileId ??
            compactParams.authProfileId?.trim() ??
            undefined,
          workspaceDir,
        })
      ).model;
    } catch {
      return fallbackResolution(initialHarness);
    }
  }
  if (!model) {
    return fallbackResolution(initialHarness);
  }
  const runtimeAuthProfileStore = isOpenAIProvider(provider)
    ? ensureAuthProfileStore(agentDir, {
        externalCliProviderIds: ["openai"],
        allowKeychainPrompt: false,
      })
    : ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
        allowKeychainPrompt: false,
      });
  const prepareRuntimeAuth = (harness: AgentHarness) =>
    prepareAgentRuntimeAuth({
      provider,
      modelId,
      modelApi: model.api,
      modelBaseUrl: model.baseUrl,
      config: compactParams.config,
      env: process.env,
      agentDir,
      workspaceDir,
      authProfileStore: runtimeAuthProfileStore,
      sessionAuthProfileId: compactParams.authProfileId,
      sessionAuthProfileSource: compactParams.authProfileIdSource,
      harnessId: harness.id,
      harnessRuntime: harness.id,
      harnessAuthBootstrap: harness.authBootstrap,
    });
  let preparation: PreparedAgentRuntimeAuth;
  if (reusableRuntimeAuthPlan) {
    preparation = {
      plan: reusableRuntimeAuthPlan,
      attempts: [{ kind: "implicit", plan: reusableRuntimeAuthPlan }],
    };
  } else {
    try {
      preparation = prepareRuntimeAuth(initialHarness);
    } catch {
      return fallbackResolution(initialHarness, model);
    }
  }
  let harness = params.pinnedHarnessId
    ? initialHarness
    : selectPreparedHarness(preparation.attempts, model);
  if (!params.pinnedHarnessId && !reusableRuntimeAuthPlan && harness.id !== initialHarness.id) {
    try {
      preparation = prepareRuntimeAuth(harness);
    } catch {
      return fallbackResolution(harness, model);
    }
    const confirmedHarness = selectPreparedHarness(preparation.attempts, model);
    if (confirmedHarness.id !== harness.id) {
      throw new Error(
        `Prepared native compaction auth routes did not converge on one agent harness for ${provider}/${modelId}.`,
      );
    }
    harness = confirmedHarness;
  }
  const materializeModel = async (input: {
    plan: AgentRuntimeAuthPlan;
    model: Model;
    forceResolve?: boolean;
  }) => {
    const materialized = await materializePreparedRuntimeModel<Model>({
      plan: input.plan,
      provider,
      modelId,
      config: compactParams.config,
      model: input.model,
      forceResolve: input.forceResolve,
      rejectMismatchedModel: true,
      resolveModel: resolvePreparedModel,
    });
    if (!materialized) {
      throw new Error(`Unable to materialize ${provider}/${modelId} for native compaction.`);
    }
    return applySecretRefHeaderSentinels(materialized, compactParams.config);
  };
  let resolved;
  try {
    resolved = await resolvePreparedRuntimeAuthAttempts<Model, HarnessCompactionResolvedAuth>({
      attempts: preparation.attempts,
      store: runtimeAuthProfileStore,
      modelId,
      model,
      materializeModel,
      resolveAuth: async ({ attempt, model: attemptModel }) => {
        if (
          (harness.authBootstrap === "harness" || attempt.plan.harnessAuthProvider) &&
          !runtimePlanRequiresHostApiKey(attempt.plan)
        ) {
          return { plan: attempt.plan, auth: {} };
        }
        const hasAutomaticPreparedCandidates =
          attempt.plan.forwardedAuthProfileSource === "auto" &&
          Boolean(
            attempt.plan.forwardedAuthProfileId ||
            attempt.plan.forwardedAuthProfileCandidateIds?.length,
          );
        const existing = hasAutomaticPreparedCandidates
          ? undefined
          : compactParams.resolvedApiKey?.trim();
        if (existing) {
          return { plan: attempt.plan, auth: { apiKey: existing } };
        }
        const auth = await resolvePreparedRuntimeModelAuth({
          plan: attempt.plan,
          model: attemptModel,
          cfg: compactParams.config,
          store: runtimeAuthProfileStore,
          agentDir,
          workspaceDir,
          ...(attempt.allowAuthProfileFallback !== undefined
            ? { allowAuthProfileFallback: attempt.allowAuthProfileFallback }
            : {}),
          secretSentinels: true,
        });
        return { plan: auth.plan, auth: { apiKey: auth.auth.apiKey?.trim() || undefined } };
      },
      errorMessage: `Prepared native compaction auth attempts could not be resolved for ${provider}/${modelId}.`,
    });
  } catch {
    return fallbackResolution(harness, model, preparation.plan);
  }
  return {
    harness,
    apiKey: resolved.auth.apiKey,
    runtimeModel: resolved.model,
    runtimeAuthPlan: resolved.plan,
  };
}

/** Runs harness-provided compaction when the selected runtime supports it. */
export async function maybeCompactAgentHarnessSession(
  params: CompactEmbeddedAgentSessionParams,
  options: InternalAgentHarnessCompactionOptions = {},
): Promise<EmbeddedAgentCompactResult | undefined> {
  const selectedRuntime = normalizeOptionalAgentRuntimeId(params.agentHarnessId);
  const pinnedHarnessId =
    selectedRuntime && !isDefaultAgentRuntimeId(selectedRuntime) ? selectedRuntime : undefined;
  if (
    !pinnedHarnessId &&
    params.provider &&
    isCliRuntimeProvider(params.provider, { config: params.config })
  ) {
    return undefined;
  }
  const runtimePolicySessionKey = params.sandboxSessionKey ?? params.sessionKey;
  const runtimePolicyAgentId =
    params.sandboxSessionKey && parseAgentSessionKey(params.sandboxSessionKey)
      ? undefined
      : params.agentId;
  const runtimeAuthPlan = params.runtimeAuthPlan ?? params.runtimePlan?.auth;
  const modelRoute = runtimeAuthPlan?.modelRoute;
  if (
    runtimeAuthPlan &&
    modelRoute &&
    (!params.provider ||
      !params.model ||
      !agentRuntimeAuthPlanMatchesTarget(runtimeAuthPlan, {
        provider: params.provider,
        modelId: params.model,
      }))
  ) {
    throw new Error(
      `Prepared runtime auth route ${modelRoute.provider}/${modelRoute.modelId} does not match the compaction target ${params.provider ?? "unknown"}/${params.model ?? "unknown"}.`,
    );
  }
  const runtime = resolveConfiguredAgentHarnessPolicy({
    provider: params.provider,
    modelId: params.model,
    config: params.config,
    agentId: runtimePolicyAgentId,
    sessionKey: runtimePolicySessionKey,
  }).runtime;
  if (
    isCliRuntimeAliasForProvider({
      runtime: pinnedHarnessId ?? runtime,
      provider: params.provider,
      cfg: params.config,
    })
  ) {
    return undefined;
  }
  const harnessSelectionParams = {
    provider: params.provider ?? "",
    modelId: params.model,
    config: params.config,
    agentId: runtimePolicyAgentId,
    sessionKey: runtimePolicySessionKey,
    agentHarnessId: pinnedHarnessId,
  };
  let harness = runtimeAuthPlan
    ? selectAgentHarnessForPreparedModelProviders({
        ...harnessSelectionParams,
        modelProviders: [
          buildHarnessCompactionModelProvider({
            model: params.runtimeModel,
            plan: runtimeAuthPlan,
          }),
        ],
      })
    : selectAgentHarness(harnessSelectionParams);
  const initialInternalHarness = harness as InternalAgentHarness;
  if (
    options.nativeCompactionRequest === "after_context_engine" &&
    !initialInternalHarness.compactAfterContextEngine
  ) {
    return undefined;
  }
  if (!options.nativeCompactionRequest && !harness.compact) {
    if (harness.id !== "openclaw") {
      return {
        ok: false,
        compacted: false,
        reason: `Agent harness "${harness.id}" does not support compaction.`,
        failure: { reason: "unsupported_harness_compaction" },
      };
    }
    return undefined;
  }
  const compactIdentity = resolveHarnessCompactIdentity(params);
  let resolvedRuntimeAuthPlan = runtimeAuthPlan;
  const compactParams = {
    ...params,
    agentDir: compactIdentity.agentDir,
    agentId: compactIdentity.agentId,
    ...(resolvedRuntimeAuthPlan
      ? {
          runtimeAuthPlan: resolvedRuntimeAuthPlan,
          ...(params.runtimePlan
            ? { runtimePlan: { ...params.runtimePlan, auth: resolvedRuntimeAuthPlan } }
            : {}),
        }
      : {}),
  };
  const resolved = await resolveHarnessCompactApiKey({
    agentDir: compactIdentity.agentDir,
    compactParams,
    initialHarness: harness,
    agentId: compactIdentity.agentId,
    sessionKey: runtimePolicySessionKey,
    pinnedHarnessId,
  });
  harness = resolved.harness;
  resolvedRuntimeAuthPlan = resolved.runtimeAuthPlan ?? resolvedRuntimeAuthPlan;
  const internalHarness = harness as InternalAgentHarness;
  const shouldCompactAfterContextEngine =
    options.nativeCompactionRequest === "after_context_engine";
  if (shouldCompactAfterContextEngine && !internalHarness.compactAfterContextEngine) {
    return undefined;
  }
  if (!options.nativeCompactionRequest && !harness.compact) {
    if (harness.id !== "openclaw") {
      return {
        ok: false,
        compacted: false,
        reason: `Agent harness "${harness.id}" does not support compaction.`,
        failure: { reason: "unsupported_harness_compaction" },
      };
    }
    return undefined;
  }
  // Native runtimes own subscription login, but a provider-locked Platform
  // route must receive the exact host-prepared key selected for this attempt.
  const harnessOwnsAuth =
    harness.authBootstrap === "harness" && !runtimePlanRequiresHostApiKey(resolvedRuntimeAuthPlan);
  const resolvedApiKey = harnessOwnsAuth ? undefined : resolved.apiKey;
  const runtimeModel = resolved.runtimeModel;
  const compactParamsWithResolvedAuth = resolvedRuntimeAuthPlan
    ? {
        ...compactParams,
        authProfileId: resolvedRuntimeAuthPlan.forwardedAuthProfileId,
        authProfileIdSource: resolvedRuntimeAuthPlan.forwardedAuthProfileSource,
        runtimeAuthPlan: resolvedRuntimeAuthPlan,
        ...(compactParams.runtimePlan
          ? {
              runtimePlan: {
                ...compactParams.runtimePlan,
                auth: resolvedRuntimeAuthPlan,
              },
            }
          : {}),
      }
    : compactParams;
  const handoffCompactParams = harnessOwnsAuth
    ? stripHarnessOwnedAuthInputs(compactParamsWithResolvedAuth)
    : compactParamsWithResolvedAuth;
  const resolvedCompactParams =
    resolvedApiKey || runtimeModel
      ? {
          ...handoffCompactParams,
          ...(resolvedApiKey
            ? {
                resolvedApiKey: unwrapSecretSentinelsForProviderEgress(
                  resolvedApiKey,
                  "plugin harness compaction handoff",
                ),
              }
            : {}),
          ...(runtimeModel
            ? {
                runtimeModel: unwrapModelHeaderSentinelsForProviderEgress(
                  runtimeModel,
                  "plugin harness compaction handoff",
                ),
              }
            : {}),
        }
      : handoffCompactParams;
  if (shouldCompactAfterContextEngine) {
    return internalHarness.compactAfterContextEngine?.(resolvedCompactParams);
  }
  return harness.compact?.(resolvedCompactParams);
}
