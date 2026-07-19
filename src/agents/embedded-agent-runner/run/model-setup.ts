import { resolveDefaultAgentDir } from "../../agent-scope.js";
import { FailoverError } from "../../failover-error.js";
import { ensureSelectedAgentHarnessPlugin } from "../../harness/runtime-plugin.js";
import { selectAgentHarness } from "../../harness/selection.js";
import { resolveSelectedOpenAIRuntimeProvider } from "../../openai-routing.js";
import {
  prepareModelRuntimeSnapshot,
  type PreparedModelRuntimeSnapshot,
} from "../../prepared-model-runtime.js";
import { createEmptyAgentDiscoveryStores, resolveModelAsync } from "../model.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { resolveRequestStreamTransportOverrides } from "./runtime-resolution.js";
import {
  buildBeforeModelResolveAttachments,
  createNativeModelOwnedRuntimeModel,
  resolveHookModelSelection,
  resolveNativeModelOwnedHarnessId,
} from "./setup.js";

export async function resolveEmbeddedRunModelSetup(params: {
  runParams: RunEmbeddedAgentParams;
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
  let firstModelResolution: Awaited<ReturnType<typeof resolveModelAsync>> | undefined;
  let modelResolution: Awaited<ReturnType<typeof resolveModelAsync>> | undefined;
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
    const modelResolutionProviders =
      selectedRuntimeProvider !== provider ? [selectedRuntimeProvider, provider] : [provider];
    for (const candidateProvider of modelResolutionProviders) {
      const candidateResolution = await resolveModelAsync(
        candidateProvider,
        modelId,
        params.agentDir,
        runParams.config,
        {
          // Dynamic hooks can resolve an explicit model without generating models.json first.
          skipAgentDiscovery: true,
          allowBundledStaticCatalogFallback: pluginHarnessOwnsTransport,
          preferBundledStaticCatalogTransport: pluginHarnessOwnsTransport,
          workspaceDir: params.workspaceDir,
          authProfileId: runParams.authProfileId,
        },
      );
      firstModelResolution ??= candidateResolution;
      if (candidateResolution.model) {
        resolvedModelProvider = candidateProvider;
        modelResolution = candidateResolution;
        break;
      }
    }
    if (!modelResolution && pluginHarnessOwnsTransport) {
      modelResolution = firstModelResolution;
    }
    if (!modelResolution) {
      const config = runParams.config ?? {};
      const preparedModelRuntime =
        params.preparedModelRuntime ??
        (await prepareModelRuntimeSnapshot({
          config,
          agentDir: params.agentDir,
          inheritedAuthDir: resolveDefaultAgentDir(config),
          workspaceDir: params.workspaceDir,
        }));
      const preparedStores = preparedModelRuntime.createStores();
      for (const candidateProvider of modelResolutionProviders) {
        const candidateResolution = await resolveModelAsync(
          candidateProvider,
          modelId,
          params.agentDir,
          runParams.config,
          {
            authStorage: preparedStores.authStorage,
            modelRegistry: preparedStores.modelRegistry,
            workspaceDir: params.workspaceDir,
            authProfileId: runParams.authProfileId,
            allowBundledStaticCatalogFallback: true,
          },
        );
        firstModelResolution ??= candidateResolution;
        if (candidateResolution.model) {
          resolvedModelProvider = candidateProvider;
          modelResolution = candidateResolution;
          break;
        }
      }
    }
    modelResolution ??= firstModelResolution;
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
    beforeAgentStartResult: hookSelection.beforeAgentStartResult,
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
