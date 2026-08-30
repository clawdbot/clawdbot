import { resolveProviderAuthProfileId } from "../../../plugins/provider-runtime.js";
import { resolveExternalCliAuthOverlayScopeFromSelection } from "../../auth-profiles/external-cli-auth-selection.js";
import type { AgentHarness } from "../../harness/types.js";
import { ensureAuthProfileStore } from "../../model-auth.js";
import { OPENAI_PROVIDER_ID } from "../../openai-routing.js";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.js";
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
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
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
  const requestedProfileId = runParams.authProfileId?.trim() || undefined;
  const lockedProfileId = runParams.authProfileIdSource === "user" ? requestedProfileId : undefined;
  const authStoreOptions = {
    config: runParams.config,
    workspaceDir: params.workspaceDir,
    pluginMetadataSnapshot: params.preparedModelRuntime?.metadataSnapshot,
    allowKeychainPrompt: false,
    externalCliProfileIds: lockedProfileId ? [lockedProfileId] : [],
  };
  const authAliasLookupParams = {
    env: process.env,
    metadataSnapshot: authStoreOptions.pluginMetadataSnapshot,
  };
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
          authAliasLookupParams,
          userPinnedAuthProfileId:
            runParams.authProfileIdSource === "user" ? runParams.authProfileId : undefined,
        });
  // CLI discovery scope never excludes provider-plugin profiles. An explicit user
  // profile remains a binding even when ambient credentials are blocked by a provider pin.
  let attemptAuthProfileStore = ensureAuthProfileStore(params.agentDir, {
    ...authStoreOptions,
    externalCliProviderIds: usesOpenAIAuthRouting
      ? [OPENAI_PROVIDER_ID]
      : (externalCliAuthScope.providerIds ?? []),
  });
  if (!initialPluginHarnessOwnsTransport && !externalCliAuthScope.providerIds) {
    externalCliAuthScope = resolveExternalCliAuthOverlayScopeFromSelection({
      provider: params.provider,
      cfg: runParams.config,
      agentId: runParams.agentId,
      modelId: params.modelId,
      workspaceDir: params.workspaceDir,
      authAliasLookupParams,
      store: attemptAuthProfileStore,
      userPinnedAuthProfileId: lockedProfileId,
    });
    if (!usesOpenAIAuthRouting && externalCliAuthScope.providerIds) {
      attemptAuthProfileStore = ensureAuthProfileStore(params.agentDir, {
        ...authStoreOptions,
        externalCliProviderIds: externalCliAuthScope.providerIds,
      });
    }
  }
  params.markStage?.("scope");
  params.markStage?.("store");

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
      metadataSnapshot: params.preparedModelRuntime?.metadataSnapshot,
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
          preparedModelRuntime: params.preparedModelRuntime,
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
