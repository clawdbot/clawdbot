import { loadSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { requireActivePluginRegistry } from "../../../plugins/runtime.js";
import { resolveSessionPinnedHarnessId } from "../../../sessions/agent-harness-session-key.js";
import { FailoverError } from "../../failover-error.js";
import { AgentHarnessPreflightError } from "../../harness/errors.js";
import { getRegisteredAgentHarness } from "../../harness/registry.js";
import { ensureSelectedAgentHarnessPlugin } from "../../harness/runtime-plugin.js";
import { selectAgentHarness } from "../../harness/selection.js";
import type { AgentHarness } from "../../harness/types.js";
import { resolveSelectedOpenAIRuntimeProvider } from "../../openai-routing.js";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.js";
import { resolveTieredModel } from "../model-resolution.js";
import { createEmptyAgentDiscoveryStores } from "../model.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { resolveRequestStreamTransportOverrides } from "./runtime-resolution.js";
import type { assertAgentHarnessRunAdmission } from "./session-bootstrap.js";
import {
  buildBeforeModelResolveAttachments,
  createNativeModelOwnedRuntimeModel,
  resolveHookModelSelection,
} from "./setup.js";

export type PreparedNativeSessionRuntime = {
  harness: AgentHarness;
  auth: "native" | "host";
  assertCurrent: () => Promise<void>;
};

async function prepareNativeSessionRuntime(
  runParams: RunEmbeddedAgentParams,
  harness: AgentHarness,
  admission: ReturnType<typeof assertAgentHarnessRunAdmission>,
): Promise<PreparedNativeSessionRuntime | undefined> {
  const pinnedHarnessId = resolveSessionPinnedHarnessId(admission?.entry);
  const resolveSessionRuntimeOwnership = harness.resolveSessionRuntimeOwnership?.bind(harness);
  if (!admission || !pinnedHarnessId || !resolveSessionRuntimeOwnership) {
    return undefined;
  }
  const { sessionId, lifecycleRevision } = admission.entry;
  const resolveOwnership = async () => {
    let active = true;
    const assertCurrent = () => {
      runParams.abortSignal?.throwIfAborted();
      if (runParams.lifecycleGeneration) {
        assertAgentRunLifecycleGenerationCurrent(runParams.lifecycleGeneration);
      }
      const current = loadSessionEntryReadOnly(admission);
      const expectedWriter = runParams.sessionTarget?.expectedWriterRunId;
      if (
        !active ||
        getRegisteredAgentHarness(pinnedHarnessId)?.harness !== harness ||
        current?.sessionId !== sessionId ||
        current?.lifecycleRevision !== lifecycleRevision ||
        resolveSessionPinnedHarnessId(current) !== pinnedHarnessId ||
        (expectedWriter !== undefined && current?.activeWriterRunId !== expectedWriter)
      ) {
        throw new AgentHarnessPreflightError(
          "Native model ownership changed during run preparation. Reattach the original native session before retrying.",
        );
      }
    };
    try {
      assertCurrent();
      const ownership = await resolveSessionRuntimeOwnership({
        config: runParams.config,
        agentId: admission.agentId,
        sessionId,
        sessionKey: admission.sessionKey,
        assertCurrent,
      });
      assertCurrent();
      return ownership;
    } finally {
      active = false;
    }
  };
  const ownership = await resolveOwnership();
  if (!ownership) {
    throw new AgentHarnessPreflightError(
      "The pinned runtime's native session ownership is unavailable. Reattach the original native session instead of starting a replacement model run.",
    );
  }
  return {
    harness,
    auth: ownership.auth,
    // Recheck both owners at dispatch; model preservation never implies native auth.
    assertCurrent: async () => {
      const current = await resolveOwnership();
      if (current?.model !== ownership.model || current.auth !== ownership.auth) {
        throw new AgentHarnessPreflightError(
          "Native model ownership changed before agent harness dispatch. Reattach the original native session before retrying.",
        );
      }
    },
  };
}

export async function resolveEmbeddedRunModelSetup(params: {
  runParams: RunEmbeddedAgentParams;
  sessionAdmission?: ReturnType<typeof assertAgentHarnessRunAdmission>;
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
    pluginRegistry: params.preparedModelRuntime?.pluginRegistry ?? requireActivePluginRegistry(),
  });
  const pinnedHarnessId = resolveSessionPinnedHarnessId(params.sessionAdmission?.entry);
  const pinnedHarness = pinnedHarnessId
    ? getRegisteredAgentHarness(pinnedHarnessId)?.harness
    : undefined;
  const nativeSessionRuntime = pinnedHarness
    ? await prepareNativeSessionRuntime(runParams, pinnedHarness, params.sessionAdmission)
    : undefined;
  if (nativeSessionRuntime?.auth === "native" && requestStreamTransportOverrides) {
    throw new AgentHarnessPreflightError(
      "Native session connections cannot apply provider stream parameters. Use a concrete model chat for this request.",
    );
  }
  const agentHarness =
    nativeSessionRuntime?.auth === "native"
      ? nativeSessionRuntime.harness
      : selectAgentHarness({
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

  const nativeModelOwned = nativeSessionRuntime !== undefined;
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
    pinnedHarnessId,
    nativeModelOwned,
    nativeSessionRuntime,
    modelConfigProvider,
    model,
    authStorage,
    modelRegistry,
  };
}
