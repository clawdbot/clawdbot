import { requireActivePluginRegistry } from "../../../plugins/runtime.js";
import { FailoverError } from "../../failover-error.js";
import { ensureSelectedAgentHarnessPlugin } from "../../harness/runtime-plugin.js";
import { selectAgentHarness } from "../../harness/selection.js";
import { resolveSelectedOpenAIRuntimeProvider } from "../../openai-routing.js";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.js";
import { resolveTieredModel } from "../model-resolution.js";
import { createEmptyAgentDiscoveryStores } from "../model.js";
import type { RunEmbeddedAgentInternalParams } from "./internal-params.js";
import { resolveRequestStreamTransportOverrides } from "./runtime-resolution.js";
import {
  buildBeforeModelResolveAttachments,
  createNativeModelOwnedRuntimeModel,
  resolveHookModelSelection,
  resolveNativeModelOwnedHarnessId,
} from "./setup.js";

export async function resolveEmbeddedRunModelSetup(params: {
  runParams: RunEmbeddedAgentInternalParams;
  provider: string;
  modelId: string;
  agentDir: string;
  workspaceDir: string;
  globalLane: string;
  hookRunner: Parameters<typeof resolveHookModelSelection>[0]["hookRunner"];
  hookContext: Parameters<typeof resolveHookModelSelection>[0]["hookContext"];
  onHooksResolved: () => void;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
}) {
  const runParams = params.runParams;
  const hookSelection = await resolveHookModelSelection({
    prompt: runParams.prompt,
    attachments: buildBeforeModelResolveAttachments(runParams.images),
    provider: params.provider,
    modelId: params.modelId,
    modelSelectionLocked: runParams.modelSelectionLocked,
    hookRunner: params.hookRunner,
    hookContext: params.hookContext,
  });
  // Hooks cannot reopen an authorized initial selection. Compare logical refs here;
  // provider-owned transport resolution may legitimately rewrite the eventual model id.
  const expectedInitialModel = runParams.expectedInitialModel;
  if (
    expectedInitialModel &&
    (hookSelection.provider !== expectedInitialModel.provider ||
      hookSelection.modelId !== expectedInitialModel.model)
  ) {
    throw new Error("Initial model selection no longer matches the authorized model override.");
  }
  const modelSelectionChangedByHook =
    hookSelection.provider !== params.provider || hookSelection.modelId !== params.modelId;
  let provider = hookSelection.provider;
  const modelId = hookSelection.modelId;
  const requestedModelId = modelId;
  const requestStreamTransportOverrides = resolveRequestStreamTransportOverrides(
    runParams.streamParams,
  );
  params.onHooksResolved();

  await ensureSelectedAgentHarnessPlugin({
    provider,
    modelId,
    config: runParams.config,
    agentId: runParams.agentId,
    sessionKey: runParams.sessionKey,
    agentHarnessId: runParams.agentHarnessId,
    agentHarnessRuntimeOverride: runParams.agentHarnessRuntimeOverride,
    requestTransportOverrides: requestStreamTransportOverrides,
    workspaceDir: params.workspaceDir,
    pluginRegistry: params.preparedModelRuntime?.pluginRegistry ?? requireActivePluginRegistry(),
  });
  const agentHarness = selectAgentHarness({
    provider,
    modelId,
    ...(requestStreamTransportOverrides
      ? {
          modelProvider: {
            requestTransportOverrides: requestStreamTransportOverrides,
          },
        }
      : {}),
    config: runParams.config,
    agentId: runParams.agentId,
    sessionKey: runParams.sessionKey,
    agentHarnessId: runParams.agentHarnessId,
    agentHarnessRuntimeOverride: runParams.agentHarnessRuntimeOverride,
  });
  const pluginHarnessOwnsTransport = agentHarness.id !== "openclaw";
  const expectedHarnessArtifact = runParams.expectedAgentHarnessRuntimeArtifact;
  if (expectedHarnessArtifact && expectedHarnessArtifact.harnessId !== agentHarness.id) {
    throw new Error(
      `Verified inference requires agent harness ${expectedHarnessArtifact.harnessId}, but ${agentHarness.id} was selected.`,
    );
  }
  if (expectedHarnessArtifact && !agentHarness.runtimeArtifact) {
    throw new Error(
      `Agent harness ${agentHarness.id} cannot attest the verified inference runtime artifact.`,
    );
  }

  const nativeModelOwnedHarnessId = resolveNativeModelOwnedHarnessId({
    agentHarnessId: runParams.agentHarnessId,
    modelSelectionLocked: runParams.modelSelectionLocked,
    selectedHarnessId: agentHarness.id,
  });
  const nativeModelOwned = nativeModelOwnedHarnessId !== undefined;
  const modelConfigProvider = provider;
  let resolvedModelProvider = provider;
  let modelResolution;
  if (nativeModelOwned) {
    modelResolution = {
      model: createNativeModelOwnedRuntimeModel({ provider, modelId }),
      ...createEmptyAgentDiscoveryStores(),
    };
  } else {
    const selectedRuntimeProvider = resolveSelectedOpenAIRuntimeProvider({
      provider,
      harnessRuntime: agentHarness.id,
      agentHarnessId: agentHarness.id,
      authProfileProvider: runParams.authProfileId?.split(":", 1)[0],
      authProfileId: runParams.authProfileId,
      config: runParams.config,
      workspaceDir: params.workspaceDir,
    });
    const tieredResolution = await resolveTieredModel({
      provider: selectedRuntimeProvider,
      ...(selectedRuntimeProvider !== provider ? { fallbackProvider: provider } : {}),
      modelId,
      agentDir: params.agentDir,
      config: runParams.config,
      workspaceDir: params.workspaceDir,
      authProfileId: runParams.authProfileId,
      preparedModelRuntime: params.preparedModelRuntime,
      staticCatalogOwnsTransport: pluginHarnessOwnsTransport,
    });
    resolvedModelProvider = tieredResolution.provider;
    modelResolution = tieredResolution.resolution;
  }
  if (!modelResolution) {
    throw new FailoverError(`Unknown model: ${provider}/${modelId}`, {
      reason: "model_not_found",
      provider,
      model: modelId,
      sessionId: runParams.sessionId,
      lane: params.globalLane,
    });
  }
  provider = resolvedModelProvider;
  const { model, error, authStorage, modelRegistry } = modelResolution;
  if (!model) {
    throw new FailoverError(error ?? `Unknown model: ${provider}/${modelId}`, {
      reason: "model_not_found",
      provider,
      model: modelId,
      sessionId: runParams.sessionId,
      lane: params.globalLane,
    });
  }

  return {
    provider,
    modelId,
    requestedModelId,
    modelSelectionChangedByHook,
    requestStreamTransportOverrides,
    expectedHarnessArtifact,
    agentHarness,
    pluginHarnessOwnsTransport,
    nativeModelOwnedHarnessId,
    nativeModelOwned,
    modelConfigProvider,
    model,
    authStorage,
    modelRegistry,
  };
}
