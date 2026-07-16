import { resolveProviderAuthProfileId } from "../../../plugins/provider-runtime.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import { resolveExternalCliAuthOverlayScopeFromSelection } from "../../auth-profiles/external-cli-auth-selection.js";
import type { AgentHarness } from "../../harness/types.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
} from "../../model-auth.js";
import { OPENAI_PROVIDER_ID } from "../../openai-routing.js";
import {
  createPreparedRuntimeModelMaterializer,
  providerUsesCredentialScopedModelMetadata,
} from "../../runtime-plan/credential-scoped-model.js";
import {
  prepareAgentRuntimeAuth,
  type PreparedAgentRuntimeAuthAttempt,
} from "../../runtime-plan/prepare-auth.js";
import { resolveModelAsync } from "../model.js";
import type { RunEmbeddedAgentParams } from "./params.js";

type ModelResolution = Awaited<ReturnType<typeof resolveModelAsync>>;
type RuntimeModel = NonNullable<ModelResolution["model"]>;

export async function prepareEmbeddedRunAuthPlan(params: {
  runParams: RunEmbeddedAgentParams;
  provider: string;
  modelId: string;
  model: RuntimeModel;
  agentDir: string;
  workspaceDir: string;
  requestStreamTransportOverrides?: "present";
  nativeModelOwned: boolean;
  authStorage: ModelResolution["authStorage"];
  modelRegistry: ModelResolution["modelRegistry"];
  getAgentHarness: () => AgentHarness;
  setAgentHarness: (harness: AgentHarness) => void;
  getRuntimeModel: () => RuntimeModel;
  getEffectiveModel: () => RuntimeModel;
  applyResolvedRuntimeModel: (model: RuntimeModel) => void;
  selectHarnessForPreparedAttempts: (
    model: RuntimeModel,
    attempts: readonly PreparedAgentRuntimeAuthAttempt[],
  ) => AgentHarness;
  markStage?: (stage: string) => void;
}) {
  const runParams = params.runParams;
  const usesOpenAIAuthRouting = params.provider === OPENAI_PROVIDER_ID;
  const initialHarness = params.getAgentHarness();
  const initialPluginHarnessOwnsTransport = initialHarness.id !== "openclaw";
  const openClawNativeCodexResponsesNeedsAuthBootstrap =
    !initialPluginHarnessOwnsTransport &&
    usesOpenAIAuthRouting &&
    params.getEffectiveModel().api === "openai-chatgpt-responses";
  let externalCliAuthScope = initialPluginHarnessOwnsTransport
    ? { ignoreAutoPreferredProfile: false }
    : openClawNativeCodexResponsesNeedsAuthBootstrap
      ? {
          providerIds: [OPENAI_PROVIDER_ID],
          ignoreAutoPreferredProfile: false,
        }
      : resolveExternalCliAuthOverlayScopeFromSelection({
          provider: params.provider,
          cfg: runParams.config,
          agentId: runParams.agentId,
          modelId: params.modelId,
          workspaceDir: params.workspaceDir,
          userLockedAuthProfileId:
            runParams.authProfileIdSource === "user" ? runParams.authProfileId : undefined,
        });
  let noExternalAuthStore: AuthProfileStore | undefined;
  if (!initialPluginHarnessOwnsTransport && !externalCliAuthScope.providerIds) {
    noExternalAuthStore = ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
      allowKeychainPrompt: false,
    });
    externalCliAuthScope = resolveExternalCliAuthOverlayScopeFromSelection({
      provider: params.provider,
      cfg: runParams.config,
      agentId: runParams.agentId,
      modelId: params.modelId,
      workspaceDir: params.workspaceDir,
      store: noExternalAuthStore,
      userLockedAuthProfileId:
        runParams.authProfileIdSource === "user" ? runParams.authProfileId : undefined,
    });
  }
  params.markStage?.("scope");

  const attemptAuthProfileStore = usesOpenAIAuthRouting
    ? ensureAuthProfileStore(params.agentDir, {
        externalCliProviderIds: [OPENAI_PROVIDER_ID],
        allowKeychainPrompt: false,
      })
    : initialPluginHarnessOwnsTransport
      ? ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
          allowKeychainPrompt: false,
        })
      : externalCliAuthScope.providerIds
        ? ensureAuthProfileStore(params.agentDir, {
            externalCliProviderIds: externalCliAuthScope.providerIds,
            allowKeychainPrompt: false,
          })
        : (noExternalAuthStore ??
          ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
            allowKeychainPrompt: false,
          }));
  params.markStage?.("store");

  const requestedProfileId = runParams.authProfileId?.trim() || undefined;
  const lockedProfileId = runParams.authProfileIdSource === "user" ? requestedProfileId : undefined;
  const preferredProfileId =
    externalCliAuthScope.ignoreAutoPreferredProfile && !lockedProfileId
      ? undefined
      : requestedProfileId;
  const createAuthPreparation = () => {
    const harness = params.getAgentHarness();
    return prepareAgentRuntimeAuth({
      provider: params.provider,
      modelId: params.modelId,
      modelApi: params.model.api,
      modelBaseUrl: params.model.baseUrl,
      requestTransportOverrides: params.requestStreamTransportOverrides,
      config: runParams.config,
      env: process.env,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      authProfileStore: attemptAuthProfileStore,
      sessionAuthProfileId: preferredProfileId,
      sessionAuthProfileSource: runParams.authProfileIdSource,
      harnessId: harness.id,
      harnessRuntime: harness.id,
      harnessAuthBootstrap: harness.authBootstrap,
      allowHarnessAuthProfileForwarding: true,
      allowTransientCooldownProbe: runParams.allowTransientCooldownProbe === true,
      resolveProviderPreferredProfileId: (context) =>
        resolveProviderAuthProfileId({
          provider: params.provider,
          config: runParams.config,
          workspaceDir: params.workspaceDir,
          env: process.env,
          context,
        }),
    });
  };
  const providerUsesProfileScopedModelMetadata = providerUsesCredentialScopedModelMetadata({
    provider: params.provider,
    modelId: params.modelId,
    config: runParams.config,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
  });
  const { materialize: materializeAuthPlan, materializeUncached: materializeAuthPlanUncached } =
    createPreparedRuntimeModelMaterializer({
      provider: params.provider,
      modelId: params.modelId,
      config: runParams.config,
      getModel: params.getRuntimeModel,
      nativeModelOwned: params.nativeModelOwned,
      requestedProfileId: runParams.authProfileId,
      providerUsesProfileScopedModelMetadata,
      resolveModel: ({ config, authProfileId, authProfileMode }) =>
        resolveModelAsync(params.provider, params.modelId, params.agentDir, config, {
          authStorage: params.authStorage,
          modelRegistry: params.modelRegistry,
          skipAgentDiscovery: true,
          allowBundledStaticCatalogFallback: true,
          preferBundledStaticCatalogTransport: true,
          workspaceDir: params.workspaceDir,
          authProfileId,
          authProfileMode,
        }),
    });

  let resolvedAuthPreparation = createAuthPreparation();
  let preparedAuthAttempts = resolvedAuthPreparation.attempts;
  let activePreparedAuthPlan = resolvedAuthPreparation.plan;
  params.applyResolvedRuntimeModel(await materializeAuthPlan(activePreparedAuthPlan));
  params.markStage?.("prepare-plan");

  const finalizedHarness = params.selectHarnessForPreparedAttempts(
    params.getEffectiveModel(),
    preparedAuthAttempts,
  );
  if (finalizedHarness.id !== params.getAgentHarness().id) {
    params.setAgentHarness(finalizedHarness);
    resolvedAuthPreparation = createAuthPreparation();
    preparedAuthAttempts = resolvedAuthPreparation.attempts;
    activePreparedAuthPlan = resolvedAuthPreparation.plan;
    params.applyResolvedRuntimeModel(await materializeAuthPlan(activePreparedAuthPlan));
    const confirmedHarness = params.selectHarnessForPreparedAttempts(
      params.getEffectiveModel(),
      preparedAuthAttempts,
    );
    if (confirmedHarness.id !== params.getAgentHarness().id) {
      throw new Error(
        `Prepared auth route did not converge on one agent harness for ${params.provider}/${params.modelId}.`,
      );
    }
  }
  params.markStage?.("harness");

  return {
    usesOpenAIAuthRouting,
    attemptAuthProfileStore,
    lockedProfileId,
    preferredProfileId,
    providerUsesProfileScopedModelMetadata,
    materializeAuthPlan,
    materializeAuthPlanUncached,
    preparedAuthAttempts,
    activePreparedAuthPlan,
  };
}
