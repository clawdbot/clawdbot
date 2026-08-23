/** Shared model, harness, and auth preparation for embedded compaction. */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { isDefaultAgentRuntimeId, normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { resolveAgentHarnessPolicy } from "../harness/policy.js";
import {
  selectAgentHarness,
  selectAgentHarnessForPreparedModelProviders,
  type AgentHarnessPreparedModelProvider,
} from "../harness/selection.js";
import {
  resolveAgentHarnessPreparedAuthSupport,
  resolveAgentHarnessPreparedRouteSupport,
} from "../harness/support.js";
import type { AgentHarness } from "../harness/types.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
} from "../model-auth.js";
import { isOpenAIProvider } from "../openai-routing.js";
import {
  providerUsesCredentialScopedModelMetadata,
  resolveReusableRuntimeModelAuth,
} from "../runtime-plan/credential-scoped-model.js";
import {
  prepareAgentRuntimeAuth,
  type PreparedAgentRuntimeAuth,
  type PreparedAgentRuntimeAuthAttempt,
} from "../runtime-plan/prepare-auth.js";
import type { AgentRuntimeAuthPlan, AgentRuntimePlan } from "../runtime-plan/types.js";
import {
  resolveCompactionHarnessRuntime,
  resolveEmbeddedCompactionTarget,
} from "./compaction-runtime-context.js";

/** Resolves the shared policy, target, and harness ownership for either compaction entry point. */
export function resolveCompactionRuntimeSelection(params: {
  config?: OpenClawConfig;
  provider?: string | null;
  modelId?: string | null;
  authProfileId?: string | null;
  modelSelectionLocked?: boolean;
  sandboxSessionKey?: string | null;
  sessionKey?: string | null;
  agentId?: string;
  boundHarnessRuntime?: string | null;
  preparedRuntimePlan?: AgentRuntimePlan;
  runtimeAuthPlan?: AgentRuntimeAuthPlan;
  selectedHarnessRuntime?: string;
}) {
  const runtimePolicySessionKey = params.sandboxSessionKey ?? params.sessionKey ?? undefined;
  const runtimePolicyAgentId =
    params.sandboxSessionKey && parseAgentSessionKey(params.sandboxSessionKey)
      ? undefined
      : params.agentId;
  const policyTarget = resolveEmbeddedCompactionTarget({
    config: params.config,
    provider: params.provider,
    modelId: params.modelId,
    authProfileId: params.authProfileId,
    modelSelectionLocked: params.modelSelectionLocked,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const policyProvider = policyTarget.provider ?? DEFAULT_PROVIDER;
  const policyModelId = policyTarget.model ?? DEFAULT_MODEL;
  const policy = resolveAgentHarnessPolicy({
    provider: policyProvider,
    modelId: policyModelId,
    config: params.config,
    agentId: runtimePolicyAgentId,
    sessionKey: runtimePolicySessionKey,
  });
  const configuredHarnessRuntime =
    policy.runtimeSource &&
    policy.runtimeSource !== "implicit" &&
    !isDefaultAgentRuntimeId(policy.runtime)
      ? policy.runtime
      : undefined;
  const boundHarnessRuntime = normalizeOptionalAgentRuntimeId(params.boundHarnessRuntime);
  const selectedHarnessRuntime =
    params.selectedHarnessRuntime ??
    resolveCompactionHarnessRuntime({
      boundHarnessRuntime,
      preparedRuntimePlan: params.preparedRuntimePlan,
      configuredHarnessRuntime,
      provider: policyProvider,
      modelId: policyModelId,
    });
  const target = resolveEmbeddedCompactionTarget({
    config: params.config,
    provider: params.provider,
    modelId: params.modelId,
    authProfileId: params.authProfileId,
    harnessRuntime: selectedHarnessRuntime,
    modelSelectionLocked: params.modelSelectionLocked,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const provider = target.provider ?? DEFAULT_PROVIDER;
  const modelId = target.model ?? DEFAULT_MODEL;
  return {
    runtimePolicySessionKey,
    runtimePolicyAgentId,
    boundHarnessRuntime,
    selectedHarnessRuntime,
    selectedHarnessRuntimeOverride: boundHarnessRuntime ? undefined : selectedHarnessRuntime,
    target,
    runtimeModelAuth: resolveReusableRuntimeModelAuth({
      plan: params.runtimeAuthPlan ?? params.preparedRuntimePlan?.auth,
      provider,
      modelId,
      authProfileId: target.authProfileId,
    }),
    provider,
    runtimeProvider: target.runtimeProvider ?? provider,
    contextConfigProvider: target.contextProvider ?? provider,
    modelId,
  };
}

function buildCompactionHarnessModelProvider(params: {
  model?: ProviderRuntimeModel;
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

/** Prepares one ordered auth-attempt set and converges it on a single compaction harness. */
export async function prepareCompactionHarnessAuth(params: {
  config?: OpenClawConfig;
  provider: string;
  metadataProvider?: string;
  modelId: string;
  model?: ProviderRuntimeModel;
  reusableRuntimeAuthPlan?: AgentRuntimeAuthPlan;
  agentDir: string;
  workspaceDir: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  runtimePolicyAgentId?: string;
  runtimePolicySessionKey?: string | null;
  agentHarnessId?: string;
  agentHarnessRuntimeOverride?: string;
  convergenceErrorPrefix?: "Prepared compaction" | "Prepared queued compaction";
}): Promise<{
  runtimeAuthProfileStore: ReturnType<typeof ensureAuthProfileStore>;
  runtimeAuthPreparation: PreparedAgentRuntimeAuth;
  selectedPreparedHarness: AgentHarness;
  providerUsesProfileScopedModelMetadata: boolean;
}> {
  const runtimeAuthProfileStore = isOpenAIProvider(params.provider)
    ? ensureAuthProfileStore(params.agentDir, {
        externalCliProviderIds: ["openai"],
        allowKeychainPrompt: false,
      })
    : ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
        allowKeychainPrompt: false,
      });
  const selectPreparedHarness = (attempts: readonly PreparedAgentRuntimeAuthAttempt[]) =>
    selectAgentHarnessForPreparedModelProviders({
      provider: params.provider,
      modelId: params.modelId,
      modelProviders: attempts.map((attempt) =>
        buildCompactionHarnessModelProvider({ model: params.model, plan: attempt.plan, attempt }),
      ),
      config: params.config,
      agentId: params.runtimePolicyAgentId,
      sessionKey: params.runtimePolicySessionKey ?? undefined,
      agentHarnessId: params.agentHarnessId,
      agentHarnessRuntimeOverride: params.agentHarnessRuntimeOverride,
    });
  const initialHarness = params.reusableRuntimeAuthPlan
    ? undefined
    : selectAgentHarness({
        provider: params.provider,
        modelId: params.modelId,
        modelProvider: buildCompactionHarnessModelProvider({ model: params.model }),
        config: params.config,
        agentId: params.runtimePolicyAgentId,
        sessionKey: params.runtimePolicySessionKey ?? undefined,
        agentHarnessId: params.agentHarnessId,
        agentHarnessRuntimeOverride: params.agentHarnessRuntimeOverride,
      });
  const prepare = (harness: AgentHarness) =>
    prepareAgentRuntimeAuth({
      provider: params.provider,
      modelId: params.modelId,
      modelApi: params.model?.api,
      modelBaseUrl: params.model?.baseUrl,
      config: params.config,
      env: process.env,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      authProfileStore: runtimeAuthProfileStore,
      sessionAuthProfileId: params.authProfileId,
      sessionAuthProfileSource: params.authProfileIdSource,
      harnessId: harness.id,
      harnessRuntime: harness.id,
      harnessAuthBootstrap: harness.authBootstrap,
    });
  let runtimeAuthPreparation: PreparedAgentRuntimeAuth = params.reusableRuntimeAuthPlan
    ? {
        plan: params.reusableRuntimeAuthPlan,
        attempts: [{ kind: "implicit", plan: params.reusableRuntimeAuthPlan }],
      }
    : prepare(initialHarness!);
  let selectedPreparedHarness = selectPreparedHarness(runtimeAuthPreparation.attempts);
  if (!params.reusableRuntimeAuthPlan && selectedPreparedHarness.id !== initialHarness?.id) {
    runtimeAuthPreparation = prepare(selectedPreparedHarness);
    const confirmedHarness = selectPreparedHarness(runtimeAuthPreparation.attempts);
    if (confirmedHarness.id !== selectedPreparedHarness.id) {
      throw new Error(
        `${params.convergenceErrorPrefix ?? "Prepared compaction"} auth routes did not converge on one agent harness for ${params.provider}/${params.modelId}.`,
      );
    }
    selectedPreparedHarness = confirmedHarness;
  }
  return {
    runtimeAuthProfileStore,
    runtimeAuthPreparation,
    selectedPreparedHarness,
    providerUsesProfileScopedModelMetadata: providerUsesCredentialScopedModelMetadata({
      provider: params.metadataProvider ?? params.provider,
      modelId: params.modelId,
      config: params.config,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
    }),
  };
}
