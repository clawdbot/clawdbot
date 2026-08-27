import type {
  WorkerLiveEvent,
  WorkerTranscriptMessage,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerInferenceContext,
  WorkerInferenceModelRef,
  WorkerInferenceOptions,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { OperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { toToolDefinitions } from "../agents/agent-tool-definition-adapter.js";
import { finalizeAgentTools } from "../agents/agent-tools.finalize.js";
import { isApplyPatchAllowedForModel } from "../agents/apply-patch-model-policy.js";
import { buildBootstrapContextForFiles } from "../agents/bootstrap-files.js";
import { createCoreCodingTools } from "../agents/core-coding-tools.js";
import { createEmbeddedAgentResourceLoader } from "../agents/embedded-agent-runner/resource-loader.js";
import { createNativeModelOwnedRuntimeModel } from "../agents/embedded-agent-runner/run/setup.js";
import { resolveSessionPermissionCoreToolPolicy } from "../agents/session-permission-exec-mode.js";
import { guardSessionManager } from "../agents/session-tool-result-guard-wrapper.js";
import { AuthStorage } from "../agents/sessions/auth-storage.js";
import { ModelRegistry } from "../agents/sessions/model-registry.js";
import { createAgentSession } from "../agents/sessions/sdk.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { SettingsManager } from "../agents/sessions/settings-manager.js";
import { resolveToolLoopDetectionConfig } from "../agents/tool-loop-detection-config.js";
import { wrapToolWithGatewayCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { DEFAULT_AGENTS_FILENAME, loadWorkspaceBootstrapFiles } from "../agents/workspace.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AssistantMessage, AssistantMessageEventStreamLike } from "../llm/types.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { createWorkerBrowserToolRuntime, type WorkerBrowserRuntime } from "./browser-runtime.js";
import { createWorkerLiveRuntime } from "./embedded-agent-live.runtime.js";
import {
  createWorkerTranscriptRuntime,
  toAgentMessage,
  toWorkerInferenceContext,
} from "./embedded-agent-transcript.runtime.js";
import type { WorkerBrowserLaunchDescriptor } from "./launch-descriptor.js";
import {
  WORKER_LOCAL_TOOL_NAMES,
  WORKER_REQUIRED_LOCAL_TOOL_NAMES,
  WORKER_SESSION_TOOL_NAMES,
  WORKER_TOOL_NAMES,
  type WorkerToolName,
} from "./tool-authority.js";
import { WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE } from "./transcript-message.js";
import { createWorkerSessionTools } from "./worker-session-tools.js";

function toWorkerAgentError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback, { cause: value });
}

type WorkerEmbeddedInferenceRequest = {
  modelRef: WorkerInferenceModelRef;
  context: WorkerInferenceContext;
  options: WorkerInferenceOptions;
  signal?: AbortSignal;
};

type WorkerEmbeddedInferenceClient = {
  stream: (
    request: WorkerEmbeddedInferenceRequest,
  ) => AssistantMessageEventStreamLike | Promise<AssistantMessageEventStreamLike>;
};

type WorkerEmbeddedTranscriptClient = {
  commit: (messages: WorkerTranscriptMessage[]) => Promise<void>;
};

type WorkerEmbeddedLiveClient = {
  enqueuePreview: (event: WorkerLiveEvent) => boolean;
  emitTerminal: (event: WorkerLiveEvent) => Promise<void>;
};

type RunWorkerEmbeddedTurnParams = {
  agentId: string;
  operationalRunInstance: OperationalRunInstanceRef;
  agentRuntimeIdentityToken: string;
  cwd: string;
  workerContainmentRoot: string;
  stateDir: string;
  sessionId: string;
  sessionKey: string;
  runId: string;
  prompt: string;
  modelRef: WorkerInferenceModelRef;
  inference: WorkerEmbeddedInferenceClient;
  transcript: WorkerEmbeddedTranscriptClient;
  live: WorkerEmbeddedLiveClient;
  sessions?: Parameters<typeof createWorkerSessionTools>[0];
  initialMessages?: WorkerTranscriptMessage[];
  suppressPromptTranscript?: boolean;
  systemPrompt?: string;
  inferenceOptions?: WorkerInferenceOptions;
  allowedToolNames: readonly WorkerToolName[];
  permissionMode?: import("../../packages/gateway-protocol/src/schema/sessions-row.js").SessionPermissionMode;
  browser?: WorkerBrowserLaunchDescriptor;
  browserRuntime?: WorkerBrowserRuntime;
  signal?: AbortSignal;
};

const WORKER_TOOL_CONFIG = { plugins: { enabled: false } } satisfies OpenClawConfig;

export async function runWorkerEmbeddedTurn(params: RunWorkerEmbeddedTurnParams): Promise<void> {
  const browserAuthorized = params.allowedToolNames.includes("browser");
  if (browserAuthorized !== (params.browser !== undefined)) {
    throw new Error("Worker Browser authority and launch descriptor must be provided together.");
  }
  if (params.operationalRunInstance.runId !== params.runId) {
    throw new Error("worker operational run instance disagrees with the admitted turn");
  }
  const model = createNativeModelOwnedRuntimeModel({
    provider: params.modelRef.provider,
    modelId: params.modelRef.model,
  });
  const authStorage = AuthStorage.inMemory({});
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const bootstrapFiles = (await loadWorkspaceBootstrapFiles(params.cwd)).filter(
    (file) => file.name === DEFAULT_AGENTS_FILENAME,
  );
  const contextFiles = buildBootstrapContextForFiles(bootstrapFiles, {});
  const resourceLoader = createEmbeddedAgentResourceLoader({
    cwd: params.cwd,
    agentDir: params.stateDir,
    settingsManager,
    // The Gateway supplies literal text, not a local prompt-file path.
    appendSystemPromptTransform: () =>
      params.systemPrompt === undefined ? [] : [params.systemPrompt],
    agentsFilesOverride: () => ({ agentsFiles: contextFiles }),
  });
  await resourceLoader.reload();

  const baseSessionManager = SessionManager.inMemory(params.cwd);
  for (const message of params.initialMessages ?? []) {
    baseSessionManager.appendMessage(toAgentMessage(message));
  }

  const transcriptRuntime = createWorkerTranscriptRuntime(params.transcript);
  const sessionManager = guardSessionManager(baseSessionManager, {
    suppressNextUserMessagePersistence: params.suppressPromptTranscript,
    onMessagePersisted: transcriptRuntime.onMessagePersisted,
  });

  const allowedToolNameSet = new Set<string>(params.allowedToolNames);
  const localToolNameSet = new Set<string>(WORKER_LOCAL_TOOL_NAMES);
  const permissionToolPolicy = params.permissionMode
    ? resolveSessionPermissionCoreToolPolicy({ mode: params.permissionMode })
    : undefined;
  const omittedToolNames = permissionToolPolicy?.readOnly
    ? new Set<WorkerToolName>(["write", "edit", "apply_patch"])
    : undefined;
  const activeToolNames = WORKER_TOOL_NAMES.filter(
    (name) => allowedToolNameSet.has(name) && !omittedToolNames?.has(name),
  );
  const headlessApprovalText = params.permissionMode
    ? `Exec denied (approval_required) in worker ${params.permissionMode} permission mode. Run this command locally for interactive approval, or ask an administrator to clear the session permission mode.`
    : undefined;
  const coreTools = createCoreCodingTools({
    codingRoot: params.cwd,
    containmentRoot: params.workerContainmentRoot,
    includeBaseCodingTools: true,
    includeShellTools: true,
    workspaceOnly: permissionToolPolicy?.workspaceOnly ?? false,
    readOnly: permissionToolPolicy?.readOnly ?? false,
    modelContextWindowTokens: model.contextWindow,
    imageSanitization: {},
    applyPatchEnabled:
      permissionToolPolicy?.readOnly !== true &&
      isApplyPatchAllowedForModel({
        modelProvider: params.modelRef.provider,
        modelId: params.modelRef.model,
      }),
    applyPatchWorkspaceOnly: permissionToolPolicy?.applyPatchWorkspaceOnly ?? true,
    execDefaults: {
      bypassHostApprovalFloors: permissionToolPolicy?.bypassHostApprovalFloors,
      host: "gateway",
      mode: permissionToolPolicy?.execMode ?? "full",
      security: "full",
      ask: "off",
      // Safe clamp v1 keeps allowlist hits local but denies misses before review.
      // Worker LLM review and interactive approval RPC remain a named follow-up.
      nonInteractiveApproval: Boolean(
        permissionToolPolicy && permissionToolPolicy.execMode !== "full",
      ),
      approvalFollowupText: headlessApprovalText,
      config: WORKER_TOOL_CONFIG,
      commandHighlighting: false,
      agentId: params.agentId,
      allowBackground: true,
      scopeKey: params.sessionKey,
      sessionKey: params.sessionKey,
      runId: params.runId,
      notifySessionKey: params.sessionKey,
      sessionId: params.sessionId,
      eventRouting: { preserveSessionKey: false },
    },
    processDefaults: { scopeKey: params.sessionKey },
  });
  const browserRuntime = params.browser
    ? await createWorkerBrowserToolRuntime({
        descriptor: params.browser,
        sessionKey: params.sessionKey,
        stateDir: params.stateDir,
        workspaceDir: params.cwd,
        ...(params.browserRuntime ? { runtime: params.browserRuntime } : {}),
      })
    : undefined;
  const { session } = await (async () => {
    try {
      const unboundLocalTools = finalizeAgentTools({
        tools: browserRuntime ? [...coreTools, browserRuntime.tool] : coreTools,
        modelProvider: params.modelRef.provider,
        modelId: params.modelRef.model,
        hookContext: {
          agentId: params.agentId,
          config: WORKER_TOOL_CONFIG,
          cwd: params.cwd,
          workspaceDir: params.cwd,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          runId: params.runId,
          requester: { senderIsOwner: true },
          loopDetection: resolveToolLoopDetectionConfig({
            cfg: WORKER_TOOL_CONFIG,
            agentId: params.agentId,
          }),
        },
        agentId: params.agentId,
      }).filter((tool) => localToolNameSet.has(tool.name));
      const localTools = unboundLocalTools.map((tool) =>
        wrapToolWithGatewayCallerIdentity(tool, {
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          operationalRunInstance: params.operationalRunInstance,
          signedAgentRuntimeIdentityToken: params.agentRuntimeIdentityToken,
        }),
      );
      const discoveredToolNames = new Set(localTools.map((tool) => tool.name));
      for (const toolName of WORKER_REQUIRED_LOCAL_TOOL_NAMES) {
        if (omittedToolNames?.has(toolName)) {
          continue;
        }
        if (!discoveredToolNames.has(toolName)) {
          throw new Error(`Worker coding tool unavailable: ${toolName}`);
        }
      }
      const activeSessionToolNames = WORKER_SESSION_TOOL_NAMES.filter((name) =>
        allowedToolNameSet.has(name),
      );
      if (activeSessionToolNames.length > 0 && !params.sessions) {
        throw new Error("Worker session tool client unavailable");
      }
      const sessionTools = params.sessions
        ? createWorkerSessionTools(params.sessions).filter((tool) =>
            allowedToolNameSet.has(tool.name),
          )
        : [];

      return await createAgentSession({
        cwd: params.cwd,
        agentDir: params.stateDir,
        authStorage,
        modelRegistry,
        model,
        thinkingLevel: "medium",
        tools: [...activeToolNames],
        customTools: toToolDefinitions([
          ...localTools.filter((tool) => allowedToolNameSet.has(tool.name)),
          ...sessionTools,
        ]),
        noTools: "all",
        sessionManager,
        settingsManager,
        resourceLoader,
        withSessionWriteSettlement: transcriptRuntime.withSessionWriteSettlement,
      });
    } catch (error) {
      await browserRuntime?.dispose();
      throw error;
    }
  })();
  session.agent.sessionId = params.sessionId;
  session.setActiveToolsByName([...activeToolNames]);
  session.agent.streamFn = (_model, context, options) => {
    const projected = toWorkerInferenceContext(context);
    if (projected.kind === "provider-replay-unavailable") {
      throw new Error(
        `${WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE} (${projected.details.reason})`,
      );
    }
    return params.inference.stream({
      modelRef: params.modelRef,
      context: projected.context,
      options: structuredClone(params.inferenceOptions ?? {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  };

  const liveRuntime = createWorkerLiveRuntime(params.live);
  const unsubscribe = session.subscribe(liveRuntime.handleSessionEvent);

  const abortTurn = () => session.agent.abort();
  params.signal?.addEventListener("abort", abortTurn, { once: true });

  let runFailure: Error | undefined;
  try {
    if (params.signal?.aborted) {
      throw toWorkerAgentError(params.signal.reason, "Worker agent turn aborted.");
    }
    await session.agent.prompt({
      role: "user",
      content: [{ type: "text", text: params.prompt }],
      timestamp: Date.now(),
    });
    await session.agent.waitForIdle();
    if (params.signal?.aborted) {
      throw toWorkerAgentError(params.signal.reason, "Worker agent turn aborted.");
    }
    const terminalAssistant = session.agent.state.messages
      .toReversed()
      .find((message): message is AssistantMessage => message.role === "assistant");
    if (terminalAssistant?.stopReason === "error") {
      throw new Error(terminalAssistant.errorMessage ?? "Worker inference failed.");
    }
    if (terminalAssistant?.stopReason === "aborted") {
      throw new Error(terminalAssistant.errorMessage ?? "Worker inference was aborted.");
    }
  } catch (error) {
    runFailure = params.signal?.aborted
      ? toWorkerAgentError(params.signal.reason, "Worker agent turn aborted.")
      : toWorkerAgentError(error, "Worker agent turn failed.");
    liveRuntime.enqueueRunFailure({
      aborted: params.signal?.aborted === true,
      error: runFailure,
    });
  }

  let finalTranscriptFailure: Error | undefined;
  try {
    try {
      await transcriptRuntime.withSessionWriteSettlement(() => undefined);
    } catch (error) {
      finalTranscriptFailure = toWorkerAgentError(error, "Worker transcript flush failed.");
    }
    if (finalTranscriptFailure === undefined) {
      await liveRuntime.emitTerminal();
    }
  } finally {
    params.signal?.removeEventListener("abort", abortTurn);
    unsubscribe();
    getProcessSupervisor().cancelScope(params.sessionKey, "manual-cancel");
    session.dispose();
    await browserRuntime?.dispose();
  }
  if (runFailure !== undefined) {
    throw runFailure;
  }
  if (finalTranscriptFailure !== undefined) {
    throw finalTranscriptFailure;
  }
}
