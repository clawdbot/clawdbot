import type {
  WorkerLiveEvent,
  WorkerTranscriptMessage,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerInferenceContext,
  WorkerInferenceModelRef,
  WorkerInferenceOptions,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { toToolDefinitions } from "../agents/agent-tool-definition-adapter.js";
import { createOpenClawCodingTools } from "../agents/agent-tools.js";
import { buildBootstrapContextForFiles } from "../agents/bootstrap-files.js";
import { createNativeModelOwnedRuntimeModel } from "../agents/embedded-agent-runner/run/setup.js";
import { guardSessionManager } from "../agents/session-tool-result-guard-wrapper.js";
import { AuthStorage } from "../agents/sessions/auth-storage.js";
import { ModelRegistry } from "../agents/sessions/model-registry.js";
import { DefaultResourceLoader } from "../agents/sessions/resource-loader.js";
import { createAgentSession } from "../agents/sessions/sdk.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { SettingsManager } from "../agents/sessions/settings-manager.js";
import { DEFAULT_AGENTS_FILENAME, loadWorkspaceBootstrapFiles } from "../agents/workspace.js";
import type { AssistantMessage, AssistantMessageEventStreamLike } from "../llm/types.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { createWorkerLiveRuntime } from "./embedded-agent-live.runtime.js";
import {
  createWorkerTranscriptRuntime,
  toAgentMessage,
  toWorkerInferenceContext,
} from "./embedded-agent-transcript.runtime.js";
import { toWorkerTranscriptMessage } from "./transcript-message.js";

const LOCAL_WORKER_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
] as const;

function toError(value: unknown, fallback: string): Error {
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
  emit: (event: WorkerLiveEvent) => Promise<void>;
};

type RunWorkerEmbeddedTurnParams = {
  cwd: string;
  stateDir: string;
  sessionId: string;
  sessionKey: string;
  runId: string;
  prompt: string;
  modelRef: WorkerInferenceModelRef;
  inference: WorkerEmbeddedInferenceClient;
  transcript: WorkerEmbeddedTranscriptClient;
  live: WorkerEmbeddedLiveClient;
  initialMessages?: WorkerTranscriptMessage[];
  suppressPromptTranscript?: boolean;
  systemPrompt?: string;
  inferenceOptions?: WorkerInferenceOptions;
  signal?: AbortSignal;
};

type RunWorkerEmbeddedTurnResult = {
  messages: WorkerTranscriptMessage[];
};

export async function runWorkerEmbeddedTurn(
  params: RunWorkerEmbeddedTurnParams,
): Promise<RunWorkerEmbeddedTurnResult> {
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
  const resourceLoader = new DefaultResourceLoader({
    cwd: params.cwd,
    agentDir: params.stateDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    ...(params.systemPrompt === undefined ? {} : { appendSystemPrompt: [params.systemPrompt] }),
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

  const toolNameSet = new Set<string>(LOCAL_WORKER_TOOL_NAMES);
  const localTools = createOpenClawCodingTools({
    cwd: params.cwd,
    workspaceDir: params.cwd,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    runSessionKey: params.sessionKey,
    runId: params.runId,
    oneShotCliRun: true,
    senderIsOwner: true,
    disableMessageTool: true,
    runtimeToolAllowlist: [...LOCAL_WORKER_TOOL_NAMES],
    modelProvider: params.modelRef.provider,
    modelId: params.modelRef.model,
    modelApi: model.api,
    modelContextWindowTokens: model.contextWindow,
    config: { plugins: { enabled: false } },
    exec: { host: "gateway", security: "full", ask: "off" },
    toolConstructionPlan: {
      includeBaseCodingTools: true,
      includeShellTools: true,
      includeChannelTools: false,
      includeOpenClawTools: false,
      includePluginTools: false,
    },
  }).filter((tool) => toolNameSet.has(tool.name));
  const discoveredToolNames = new Set(localTools.map((tool) => tool.name));
  for (const toolName of LOCAL_WORKER_TOOL_NAMES) {
    if (!discoveredToolNames.has(toolName)) {
      throw new Error(`Worker coding tool unavailable: ${toolName}`);
    }
  }

  const { session } = await createAgentSession({
    cwd: params.cwd,
    agentDir: params.stateDir,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: "medium",
    tools: [...LOCAL_WORKER_TOOL_NAMES],
    customTools: toToolDefinitions(localTools),
    noTools: "all",
    sessionManager,
    settingsManager,
    resourceLoader,
    withSessionWriteLock: transcriptRuntime.withSessionWriteLock,
  });
  session.agent.sessionId = params.sessionId;
  session.setActiveToolsByName([...LOCAL_WORKER_TOOL_NAMES]);
  session.agent.streamFn = (_model, context, options) =>
    params.inference.stream({
      modelRef: params.modelRef,
      context: toWorkerInferenceContext(context),
      options: structuredClone(params.inferenceOptions ?? {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    });

  const liveRuntime = createWorkerLiveRuntime(params.live);
  const unsubscribe = session.subscribe(liveRuntime.handleSessionEvent);

  const abortTurn = () => session.agent.abort();
  params.signal?.addEventListener("abort", abortTurn, { once: true });

  let runFailure: Error | undefined;
  try {
    if (params.signal?.aborted) {
      throw toError(params.signal.reason, "Worker agent turn aborted.");
    }
    await session.agent.prompt({
      role: "user",
      content: [{ type: "text", text: params.prompt }],
      timestamp: Date.now(),
    });
    await session.agent.waitForIdle();
    if (params.signal?.aborted) {
      throw toError(params.signal.reason, "Worker agent turn aborted.");
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
      ? toError(params.signal.reason, "Worker agent turn aborted.")
      : toError(error, "Worker agent turn failed.");
    liveRuntime.enqueueRunFailure({ aborted: params.signal?.aborted === true, error: runFailure });
  }

  let finalTranscriptFailure: Error | undefined;
  try {
    try {
      await transcriptRuntime.withSessionWriteLock(() => undefined);
    } catch (error) {
      finalTranscriptFailure = toError(error, "Worker transcript flush failed.");
    }
    await liveRuntime.flush();
    if (finalTranscriptFailure === undefined) {
      await liveRuntime.emitTerminal();
    }
  } finally {
    params.signal?.removeEventListener("abort", abortTurn);
    unsubscribe();
    getProcessSupervisor().cancelScope(params.sessionKey, "manual-cancel");
    session.dispose();
  }
  if (runFailure !== undefined) {
    throw runFailure;
  }
  if (finalTranscriptFailure !== undefined) {
    throw finalTranscriptFailure;
  }

  return {
    messages: session.agent.state.messages.flatMap((message) => {
      const projected = toWorkerTranscriptMessage(message);
      return projected ? [projected] : [];
    }),
  };
}
