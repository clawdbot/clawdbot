import type { MessageOptions, SessionConfig, Tool as SdkTool } from "@github/copilot-sdk";
import type { AgentMessage, SandboxContext } from "openclaw/plugin-sdk/agent-harness-runtime";
import { toStringifiedError as toCopilotError } from "openclaw/plugin-sdk/error-runtime";

export { toCopilotError };
import {
  detectAndLoadAgentHarnessPromptImages,
  getModelProviderRequestTransport,
  resolveUserPath,
  TRANSCRIPT_CREDENTIAL_SAFETY_PROMPT,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { readNonEmptyStringPreservingWhitespace as readNonEmptyString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  COPILOT_ASK_USER_AVAILABLE_TOOLS,
  COPILOT_SETTLED_FINALIZATION_SYSTEM_MESSAGE,
  withPromptFailure,
  type AgentHarnessAttemptResult,
  type AttemptParamsLike,
  type AttemptResultWithSdkSessionId,
  type CopilotAttemptOperation,
  type CopilotSessionConfig,
  type ModelRef,
  type ModelRefInputObject,
  type PromptErrorWithCode,
} from "./attempt-types.js";
import { createCopilotByokAuth, resolveCopilotAuth } from "./auth-bridge.js";
import type { AssistantMessage, AssistantUsageSnapshot } from "./event-bridge.js";
import { createHooksBridge } from "./hooks-bridge.js";
import { createPermissionBridge, rejectAllPolicy } from "./permission-bridge.js";
import { resolveCopilotProvider, type ResolvedCopilotProvider } from "./provider-bridge.js";
import { computeReplayMetadata, copilotToolMetasHavePotentialSideEffects } from "./replay-shim.js";
import type { ClientCreateOptions, PoolKey } from "./runtime.js";
import { createCopilotIsolatedSessionRestrictions } from "./session-restrictions.js";
export function createResult(
  params: AttemptParamsLike,
  state: {
    aborted?: boolean;
    assistantTranscriptOwned?: boolean;
    assistantTranscriptIdempotencyKey?: string;
    contextEngineTerminalAnchor?: import("openclaw/plugin-sdk/session-transcript-runtime").TranscriptEntryAnchor;
    assistantTexts?: string[];
    codeModeEngaged?: boolean;
    currentAttemptAssistant?: AssistantMessage;
    currentAttemptCompletedAssistant?: AssistantMessage;
    downgradedFromResume?: boolean;
    externalAbort?: boolean;
    itemLifecycle?: { activeCount: number; completedCount: number; startedCount: number };
    lastAssistant?: AssistantMessage;
    journalValidated?: boolean;
    lastToolError?: AgentHarnessAttemptResult["lastToolError"];
    messagesSnapshot: AgentMessage[];
    nativeReplayInvalid?: boolean;
    now: () => number;
    promptError: Error | undefined;
    resumeFailureRecovered?: boolean;
    sdkSessionId?: string;
    sessionIdUsed?: string;
    timedOut?: boolean;
    timedOutDuringCompaction?: boolean;
    toolMetas?: AgentHarnessAttemptResult["toolMetas"];
    usage?: AssistantUsageSnapshot;
    yieldDetected?: boolean;
  },
): AttemptResultWithSdkSessionId {
  const promptError = state.promptError;
  const transcriptPersistenceFailed =
    (promptError as PromptErrorWithCode | undefined)?.code === "transcript_persistence_failed";
  const timedOut = state.timedOut === true;
  const toolMetas = state.toolMetas ?? [];
  const replayMetadata =
    params.operation === "settled-tool-finalization"
      ? {
          hadPotentialSideEffects: false,
          replaySafe: state.nativeReplayInvalid !== true && !transcriptPersistenceFailed,
        }
      : computeReplayMetadata({
          priorReplayInvalid:
            params.initialReplayState?.replayInvalid === true ||
            state.nativeReplayInvalid === true ||
            transcriptPersistenceFailed,
          priorHadPotentialSideEffects: params.initialReplayState?.hadPotentialSideEffects,
          thisAttemptTimedOut: timedOut,
          thisAttemptHadPotentialSideEffects: copilotToolMetasHavePotentialSideEffects(toolMetas),
          thisAttemptDowngradedFromResume: state.downgradedFromResume,
          thisAttemptResumeFailureRecovered: state.resumeFailureRecovered,
        });
  const interruption = timedOut
    ? {
        kind: "timeout" as const,
        phase: state.timedOutDuringCompaction ? ("compaction" as const) : ("prompt" as const),
        source: state.externalAbort ? ("external" as const) : ("runtime" as const),
        ...(state.aborted ? { aborted: true as const } : {}),
      }
    : state.aborted
      ? {
          kind: "aborted" as const,
          source: state.externalAbort ? ("external" as const) : ("runtime" as const),
        }
      : { kind: "ok" as const };
  const terminal =
    promptError !== undefined ? withPromptFailure(interruption, promptError) : interruption;
  return {
    terminal,
    ...(state.assistantTranscriptOwned
      ? {
          assistantTranscriptOwned: true,
          ...(state.assistantTranscriptIdempotencyKey
            ? { assistantTranscriptIdempotencyKey: state.assistantTranscriptIdempotencyKey }
            : {}),
        }
      : {}),
    ...(state.sdkSessionId ? { sdkSessionId: state.sdkSessionId } : {}),
    ...(state.contextEngineTerminalAnchor
      ? { contextEngineTerminalAnchor: state.contextEngineTerminalAnchor }
      : {}),
    ...(state.journalValidated !== undefined ? { journalValidated: state.journalValidated } : {}),
    ...(state.codeModeEngaged !== undefined ? { codeModeEngaged: state.codeModeEngaged } : {}),
    assistantTexts: state.assistantTexts ?? [],
    attemptUsage: state.usage,
    cloudCodeAssistFormatError: false,
    currentAttemptAssistant: state.currentAttemptAssistant,
    currentAttemptCompletedAssistant: state.currentAttemptCompletedAssistant,
    didSendViaMessagingTool: false,
    itemLifecycle: state.itemLifecycle ?? {
      activeCount: 0,
      completedCount: 0,
      startedCount: 0,
    },
    lastAssistant: state.lastAssistant,
    ...(state.lastToolError ? { lastToolError: state.lastToolError } : {}),
    messagesSnapshot: state.messagesSnapshot,
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSentTexts: [],
    replayMetadata,
    sessionFileUsed: readNonEmptyString(params.sessionFile),
    sessionIdUsed: state.sessionIdUsed ?? readNonEmptyString(params.sessionId) ?? "copilot-session",
    toolMetas,
    yieldDetected: state.yieldDetected === true,
  };
}
export function createPromptError(
  code: string,
  message: string,
  cause?: unknown,
): PromptErrorWithCode {
  const error = new Error(message) as PromptErrorWithCode;
  error.code = code;
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}
export function createSessionConfig(
  params: AttemptParamsLike,
  sdkModelId: string,
  sdkTools: SdkTool[],
  resolvedAuth: ReturnType<typeof resolveCopilotAuth>,
  resolvedProvider: ResolvedCopilotProvider,
  systemMessageContent: string | undefined,
  effectiveWorkspaceDir: string | undefined,
  effectiveCwd: string | undefined,
  onUserInputRequest: SessionConfig["onUserInputRequest"] | undefined,
  options: {
    hooksBridgeOptions?: Parameters<typeof createHooksBridge>[1];
    includeAskUser: boolean;
    operation: CopilotAttemptOperation;
  },
): CopilotSessionConfig {
  const settledToolFinalization = options.operation === "settled-tool-finalization";
  const permissionPolicy = settledToolFinalization
    ? rejectAllPolicy
    : (params.permissionPolicy ?? rejectAllPolicy);
  const hooks = settledToolFinalization
    ? undefined
    : createHooksBridge(params.hooksConfig, options.hooksBridgeOptions);
  return {
    model: sdkModelId,
    onPermissionRequest: createPermissionBridge(permissionPolicy),
    ...(onUserInputRequest ? { onUserInputRequest } : {}),
    ...(resolvedProvider.provider ? { provider: resolvedProvider.provider } : {}),
    ...(hooks ? { hooks } : {}),
    ...(typeof params.enableSessionTelemetry === "boolean"
      ? { enableSessionTelemetry: params.enableSessionTelemetry }
      : {}),
    ...(settledToolFinalization
      ? {}
      : params.infiniteSessionConfig
        ? { infiniteSessions: params.infiniteSessionConfig }
        : {}),
    reasoningEffort: params.reasoningEffort,
    tools: sdkTools,
    availableTools: buildCopilotAvailableTools(sdkTools, options.includeAskUser),
    ...(settledToolFinalization ? createCopilotIsolatedSessionRestrictions() : {}),
    workingDirectory:
      effectiveCwd ?? effectiveWorkspaceDir ?? readResolvedAttemptPath(params.workspaceDir),
    ...(!settledToolFinalization &&
    effectiveWorkspaceDir &&
    effectiveCwd &&
    effectiveCwd !== effectiveWorkspaceDir
      ? { instructionDirectories: [effectiveWorkspaceDir] }
      : {}),
    ...(resolvedAuth.authMode === "gitHubToken" && resolvedAuth.gitHubToken
      ? { gitHubToken: resolvedAuth.gitHubToken }
      : {}),
    ...(settledToolFinalization
      ? {
          systemMessage: {
            mode: "customize" as const,
            content: COPILOT_SETTLED_FINALIZATION_SYSTEM_MESSAGE,
          },
        }
      : systemMessageContent
        ? {
            systemMessage: {
              mode: "append" as const,
              content: systemMessageContent,
            },
          }
        : {}),
  };
}
function buildCopilotAvailableTools(sdkTools: SdkTool[], includeAskUser: boolean): string[] {
  const availableTools = sdkTools.map((tool) => tool.name);
  if (includeAskUser) {
    availableTools.push(...COPILOT_ASK_USER_AVAILABLE_TOOLS);
  }
  return [...new Set(availableTools)];
}
export async function createMessageOptions(
  params: AttemptParamsLike,
  context: {
    effectiveCwd: string | undefined;
    effectiveWorkspaceDir: string | undefined;
    provider: ResolvedCopilotProvider;
    sandbox: SandboxContext | null;
    workspaceOnly: boolean;
  },
): Promise<MessageOptions> {
  const attachments = createPromptImageAttachments(await resolvePromptImages(params, context));
  const providerHeaders = context.provider.provider?.headers;
  const requestHeaders =
    providerHeaders && Object.keys(providerHeaders).length > 0 ? { ...providerHeaders } : undefined;
  return {
    prompt: params.prompt,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(requestHeaders ? { requestHeaders } : {}),
  };
}
function createPromptImageAttachments(
  images: unknown[],
): NonNullable<MessageOptions["attachments"]> {
  return images.flatMap((image, index) => {
    if (
      !image ||
      typeof image !== "object" ||
      (image as { type?: unknown }).type !== "image" ||
      typeof (image as { data?: unknown }).data !== "string" ||
      typeof (image as { mimeType?: unknown }).mimeType !== "string"
    ) {
      return [];
    }
    return [
      {
        type: "blob" as const,
        data: (image as { data: string }).data,
        mimeType: (image as { mimeType: string }).mimeType,
        displayName: `prompt-image-${index + 1}`,
      },
    ];
  });
}
async function resolvePromptImages(
  params: AttemptParamsLike,
  context: {
    effectiveCwd: string | undefined;
    effectiveWorkspaceDir: string | undefined;
    sandbox: SandboxContext | null;
    workspaceOnly: boolean;
  },
): Promise<unknown[]> {
  const workspaceDir =
    context.effectiveCwd ??
    context.effectiveWorkspaceDir ??
    readResolvedAttemptPath(params.cwd) ??
    readResolvedAttemptPath(params.workspaceDir);
  if (!workspaceDir) {
    return [];
  }
  const localRoots =
    context.workspaceOnly && context.effectiveWorkspaceDir
      ? [context.effectiveWorkspaceDir]
      : undefined;
  const result = await detectAndLoadAgentHarnessPromptImages({
    prompt: params.prompt,
    workspaceDir,
    model: resolveImageCapabilityModel(params),
    existingImages: Array.isArray(params.images) ? params.images : undefined,
    imageOrder: Array.isArray(params.imageOrder) ? params.imageOrder : undefined,
    media: Array.isArray(params.media) ? params.media : undefined,
    config: params.config,
    workspaceOnly: context.workspaceOnly,
    localRoots,
    sandbox:
      context.sandbox?.enabled && context.sandbox.fsBridge
        ? { root: context.sandbox.workspaceDir, bridge: context.sandbox.fsBridge }
        : undefined,
  });
  return result.images;
}
function resolveImageCapabilityModel(params: AttemptParamsLike): { input?: string[] } {
  const model = params.model;
  if (model && typeof model === "object" && Array.isArray((model as { input?: unknown }).input)) {
    return { input: (model as { input: string[] }).input };
  }
  return { input: ["image"] };
}
export function createSystemMessageContent(
  params: AttemptParamsLike,
  workspaceBootstrapInstructions: string | undefined,
): string | undefined {
  if (isRawCopilotModelRun(params)) {
    return undefined;
  }
  const sections: string[] = [TRANSCRIPT_CREDENTIAL_SAFETY_PROMPT];
  const bootstrap = workspaceBootstrapInstructions?.trim();
  if (bootstrap) {
    sections.push(bootstrap);
  }
  const extraSystemPrompt = readNonEmptyString(params.extraSystemPrompt)?.trim();
  if (extraSystemPrompt) {
    const contextHeader =
      params.promptMode === "minimal" ? "## Subagent Context" : "## Conversation Context";
    sections.push(`${contextHeader}\n${extraSystemPrompt}`);
  }
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}
export function isRawCopilotModelRun(params: AttemptParamsLike): boolean {
  return params.modelRun === true || params.promptMode === "none";
}
export { readNonEmptyString };
export function readResolvedAttemptPath(value: unknown): string | undefined {
  const raw = readNonEmptyString(value)?.trim();
  if (!raw) {
    return undefined;
  }
  if (process.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(raw)) {
    return raw;
  }
  return resolveUserPath(raw);
}
export function resolveModelRef(params: AttemptParamsLike): ModelRef {
  const rawModel = (params as { runtimeModel?: unknown }).runtimeModel ?? params.model;
  if (rawModel && typeof rawModel === "object") {
    const model = rawModel as ModelRefInputObject;
    const requestTransport = getModelProviderRequestTransport(rawModel);
    const rawRequest = model.request;
    return {
      api: readNonEmptyString(model.api),
      id:
        readNonEmptyString(model.id) ??
        readNonEmptyString((params as { modelId?: unknown }).modelId) ??
        "unknown-model",
      provider:
        readNonEmptyString(model.provider) ??
        readNonEmptyString((params as { provider?: unknown }).provider) ??
        "unknown-provider",
      baseUrl: readNonEmptyString(model.baseUrl),
      azureApiVersion: readNonEmptyString(model.azureApiVersion ?? model.params?.azureApiVersion),
      headers: model.headers,
      authHeader: model.authHeader,
      requestAuthMode: readNonEmptyString(requestTransport?.auth?.mode ?? rawRequest?.auth?.mode),
      requestProxy: requestTransport?.proxy ?? rawRequest?.proxy,
      requestTls: requestTransport?.tls ?? rawRequest?.tls,
      requestAllowPrivateNetwork:
        requestTransport?.allowPrivateNetwork ?? rawRequest?.allowPrivateNetwork,
      contextTokens: model.contextTokens,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    };
  }
  return {
    id:
      readNonEmptyString(typeof rawModel === "string" ? rawModel : undefined) ??
      readNonEmptyString((params as { modelId?: unknown }).modelId) ??
      "unknown-model",
    provider: readNonEmptyString((params as { provider?: unknown }).provider) ?? "unknown-provider",
  };
}
export function resolvePoolAcquire(params: AttemptParamsLike): {
  key: PoolKey;
  options: ClientCreateOptions;
  auth: ReturnType<typeof resolveCopilotAuth>;
  provider: ResolvedCopilotProvider;
} {
  const model = resolveModelRef(params);
  const provider = resolveCopilotProvider({
    model,
    resolvedApiKey: readNonEmptyString(params.resolvedApiKey),
    authProfileId: readNonEmptyString(params.authProfileId),
  });
  const auth =
    provider.mode === "byok"
      ? createCopilotByokAuth({
          agentId: readNonEmptyString(params.agentId),
          agentDir: readNonEmptyString(params.agentDir),
          workspaceDir: readNonEmptyString(params.workspaceDir),
          copilotHome: readNonEmptyString(params.copilotHome),
          authProfileId: provider.authProfileId,
          authProfileVersion: provider.authProfileVersion,
        })
      : resolveCopilotAuth({
          agentId: readNonEmptyString(params.agentId),
          agentDir: readNonEmptyString(params.agentDir),
          workspaceDir: readNonEmptyString(params.workspaceDir),
          copilotHome: readNonEmptyString(params.copilotHome),
          auth: params.auth,
          resolvedApiKey: readNonEmptyString(params.resolvedApiKey),
          authProfileId: readNonEmptyString(params.authProfileId),
          profileVersion: readNonEmptyString(params.profileVersion),
        });
  return {
    key: {
      agentId: auth.agentId,
      authMode: auth.authMode,
      ...(auth.authMode === "gitHubToken" || auth.authMode === "byok"
        ? {
            authProfileId: auth.authProfileId,
            authProfileVersion: auth.authProfileVersion,
          }
        : {}),
      copilotHome: auth.copilotHome,
    },
    options: {
      copilotHome: auth.copilotHome,
      ...(auth.authMode === "gitHubToken" && auth.gitHubToken
        ? { gitHubToken: auth.gitHubToken }
        : {}),
      useLoggedInUser: auth.authMode === "useLoggedInUser",
    },
    auth,
    provider,
  };
}
export function isSdkSendAndWaitTimeoutError(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") {
    return false;
  }
  return /^Timeout after \d+ms waiting for session\.idle$/.test(message);
}
