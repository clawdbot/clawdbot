// Codex plugin module implements conversation binding behavior.
import {
  formatErrorMessage,
  resolveSandboxContext,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveSessionAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import { loadExecApprovals } from "openclaw/plugin-sdk/exec-approvals-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type {
  PluginConversationBindingResolvedEvent,
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveCodexAppServerForModelProvider } from "./app-server/app-server-policy.js";
import { resolveCodexAppServerAuthProfileIdForAgent } from "./app-server/auth-bridge.js";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import {
  canUseCodexModelBackedApprovalsReviewerForModel,
  codexSandboxPolicyForTurn,
  resolveOpenClawExecPolicyForCodexAppServer,
  resolveCodexAppServerRuntimeOptions,
  type CodexAppServerApprovalPolicy,
  type CodexAppServerSandboxMode,
  type OpenClawExecPolicyForCodexAppServer,
} from "./app-server/config.js";
import { assertCodexThreadStartResponse } from "./app-server/protocol-validators.js";
import type {
  CodexServiceTier,
  CodexThreadResumeResponse,
  CodexThreadStartResponse,
  CodexTurnStartResponse,
  JsonObject,
  JsonValue,
} from "./app-server/protocol.js";
import {
  resolveCodexNativeExecutionBlock,
  resolveCodexNativeSandboxBlock,
} from "./app-server/sandbox-guard.js";
import {
  assertCodexBindingMayBeReplaced,
  isCodexAppServerNativeAuthProfile,
  normalizeCodexAppServerBindingModelProvider,
  sessionBindingIdentity,
  type CodexAppServerAuthProfileLookup,
  type CodexAppServerBindingIdentity,
  type CodexAppServerBindingStore,
} from "./app-server/session-binding.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseCodexAppServerClientLease,
  withLeasedCodexAppServerClientStartSelectionRetry,
  type CodexAppServerClientLease,
  type CodexAppServerClientOptions,
} from "./app-server/shared-client.js";
import {
  CODEX_NATIVE_PERSONALITY_NONE,
  resolveCodexAppServerRequestModelSelection,
} from "./app-server/thread-lifecycle.js";
import { resumeCodexAppServerThread } from "./app-server/thread-resume.js";
import { canMutateCodexHost, CODEX_NATIVE_EXECUTION_AUTH_ERROR } from "./command-authorization.js";
import { formatCodexDisplayText } from "./command-formatters.js";
import {
  createCodexConversationBindingData,
  readCodexConversationBindingData,
  readCodexConversationBindingDataRecord,
  resolveCodexDefaultWorkspaceDir,
  type CodexAppServerConversationBindingData,
} from "./conversation-binding-data.js";
import { trackCodexConversationActiveTurn } from "./conversation-control.js";
import { createCodexConversationTurnCollector } from "./conversation-turn-collector.js";
import { buildCodexConversationTurnInput } from "./conversation-turn-input.js";
import { resumeCodexCliSessionOnNode } from "./node-cli-sessions.js";

const DEFAULT_BOUND_TURN_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_AGENT_ID = "main";
const VALID_AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_AGENT_ID_CHARS_PATTERN = /[^a-z0-9_-]+/g;
const LEADING_DASH_PATTERN = /^-+/;
const TRAILING_DASH_PATTERN = /-+$/;
const NATIVE_CONVERSATION_INTERACTIVE_APPROVALS_UNAVAILABLE =
  "OpenClaw native Codex conversation binding cannot route interactive approvals yet; use the Codex harness or explicit /acp spawn codex for that workflow.";

type CodexConversationRunOptions = {
  bindingStore: CodexAppServerBindingStore;
  pluginConfig?: unknown;
  config?: CodexConversationConfig;
  timeoutMs?: number;
  resumeCodexCliSessionOnNode?: ResumeCodexCliSessionOnNodeFn;
};

type ResumeCodexCliSessionOnNodeFn = (
  params: Omit<Parameters<typeof resumeCodexCliSessionOnNode>[0], "runtime">,
) => ReturnType<typeof resumeCodexCliSessionOnNode>;

type CodexConversationStartParams = {
  bindingStore: CodexAppServerBindingStore;
  pluginConfig?: unknown;
  config?: CodexConversationConfig;
  sessionFile: string;
  workspaceDir?: string;
  agentDir?: string;
  sessionKey?: string;
  agentId?: string;
  threadId?: string;
  model?: string;
  modelProvider?: string;
  authProfileId?: string;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  sandbox?: CodexAppServerSandboxMode;
  serviceTier?: CodexServiceTier;
};

type BoundTurnResult = {
  reply: ReplyPayload;
};

type CodexConversationConfig = Parameters<
  typeof resolveCodexAppServerAuthProfileIdForAgent
>[0]["config"];
type ResolvedCodexConversationConfig = NonNullable<CodexConversationConfig>;

type CodexConversationGlobalState = {
  queue: KeyedAsyncQueue;
};

async function resolveConversationAppServerRuntime(params: {
  pluginConfig?: unknown;
  config?: CodexConversationConfig;
  agentId?: string;
  agentDir?: string;
  sessionKey?: string;
  workspaceDir: string;
  modelProvider?: string;
  model?: string;
}): Promise<{
  execPolicy?: OpenClawExecPolicyForCodexAppServer;
  runtime: ReturnType<typeof resolveCodexAppServerRuntimeOptions>;
}> {
  const execPolicy = resolveConversationExecPolicy({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const sandboxForPolicy =
    execPolicy.touched && execPolicy.security === "full" && execPolicy.ask !== "off"
      ? await resolveSandboxContext({
          config: params.config,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
        })
      : undefined;
  const runtime = resolveCodexAppServerRuntimeOptions({
    pluginConfig: params.pluginConfig,
    execPolicy,
    modelProvider: params.modelProvider,
    model: params.model,
    config: params.config,
    agentDir: params.agentDir,
    openClawSandboxActive: Boolean(sandboxForPolicy?.enabled),
  });
  return { execPolicy, runtime };
}

const CODEX_CONVERSATION_GLOBAL_STATE = Symbol.for("openclaw.codex.conversationBinding");
const CODEX_CONVERSATION_THREAD_DEVELOPER_INSTRUCTIONS =
  "This Codex thread is bound to an OpenClaw conversation. Answer normally; OpenClaw will deliver your final response back to the conversation.";

function getGlobalState(): CodexConversationGlobalState {
  const globalState = globalThis as typeof globalThis & {
    [CODEX_CONVERSATION_GLOBAL_STATE]?: CodexConversationGlobalState;
  };
  globalState[CODEX_CONVERSATION_GLOBAL_STATE] ??= { queue: new KeyedAsyncQueue() };
  return globalState[CODEX_CONVERSATION_GLOBAL_STATE];
}

async function startCodexConversationThread(
  params: CodexConversationStartParams,
): Promise<CodexAppServerConversationBindingData> {
  const workspaceDir =
    params.workspaceDir?.trim() || resolveCodexDefaultWorkspaceDir(params.pluginConfig);
  const agentDir = params.agentDir?.trim();
  const agentLookup = buildAgentLookup({ agentDir, config: params.config });
  const identity = sessionBindingIdentity({
    agentId: params.agentId,
    sessionId: params.sessionFile,
    sessionKey: params.sessionKey,
    config: params.config,
  });
  const existingBinding = await params.bindingStore.read(identity);
  assertCodexBindingMayBeReplaced(existingBinding, "starting a conversation-bound Codex thread");
  const authProfileId = resolveCodexAppServerAuthProfileIdForAgent({
    authProfileId: params.authProfileId ?? existingBinding?.authProfileId,
    ...agentLookup,
  });
  if (params.threadId?.trim()) {
    await attachExistingThread({
      pluginConfig: params.pluginConfig,
      bindingStore: params.bindingStore,
      identity,
      threadId: params.threadId.trim(),
      workspaceDir,
      ...(agentDir ? { agentDir } : {}),
      model: params.model,
      modelProvider: params.modelProvider,
      authProfileId,
      approvalPolicy: params.approvalPolicy,
      sandbox: params.sandbox,
      serviceTier: params.serviceTier,
      config: params.config,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    });
  } else {
    await createThread({
      pluginConfig: params.pluginConfig,
      bindingStore: params.bindingStore,
      identity,
      workspaceDir,
      ...(agentDir ? { agentDir } : {}),
      model: params.model,
      modelProvider: params.modelProvider,
      authProfileId,
      approvalPolicy: params.approvalPolicy,
      sandbox: params.sandbox,
      serviceTier: params.serviceTier,
      config: params.config,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    });
  }
  const storedBinding = await params.bindingStore.read(identity);
  if (!storedBinding) {
    throw new Error("Codex session binding disappeared while starting its conversation thread.");
  }
  return createCodexConversationBindingData({
    source: {
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      threadId: storedBinding.threadId,
      ...(identity.sessionKey ? { sessionKey: identity.sessionKey } : {}),
    },
    workspaceDir,
    ...(agentDir ? { agentDir } : {}),
    agentId: params.agentId,
  });
}

async function handleCodexConversationInboundClaim(
  event: PluginHookInboundClaimEvent,
  ctx: PluginHookInboundClaimContext,
  options: CodexConversationRunOptions,
): Promise<{ handled: boolean; reply?: ReplyPayload } | undefined> {
  const data = readCodexConversationBindingData(ctx.pluginBinding);
  if (!data) {
    return undefined;
  }
  if (event.commandAuthorized !== true) {
    return { handled: true };
  }
  const prompt = event.bodyForAgent?.trim() || event.content?.trim() || "";
  if (!prompt) {
    return { handled: true };
  }
  if (!canMutateCodexHost(event)) {
    return { handled: true, reply: { text: CODEX_NATIVE_EXECUTION_AUTH_ERROR } };
  }
  const nativeExecutionBlock =
    data.kind === "codex-cli-node-session"
      ? resolveCodexNativeSandboxBlock({
          config: options.config,
          sessionKey: event.sessionKey ?? ctx.sessionKey,
          surface: "Codex CLI node conversation binding",
        })
      : resolveCodexNativeExecutionBlock({
          config: options.config,
          sessionKey: event.sessionKey ?? ctx.sessionKey,
          agentId: data.agentId,
          surface: "Codex app-server conversation binding",
        });
  if (nativeExecutionBlock) {
    return { handled: true, reply: { text: nativeExecutionBlock } };
  }
  if (data.kind === "codex-cli-node-session") {
    const resume = options.resumeCodexCliSessionOnNode;
    if (!resume) {
      return {
        handled: true,
        reply: {
          text: "Codex CLI node binding is unavailable because Gateway node runtime is not attached.",
        },
      };
    }
    try {
      const result = await enqueueBoundTurn(`${data.nodeId}:${data.sessionId}`, async () => {
        const resumed = await resume({
          nodeId: data.nodeId,
          sessionId: data.sessionId,
          prompt,
          cwd: data.cwd,
          timeoutMs: options.timeoutMs,
        });
        return { reply: { text: resumed.text.trim() || "Codex completed without a text reply." } };
      });
      return { handled: true, reply: result.reply };
    } catch (error) {
      return {
        handled: true,
        reply: {
          text: `Codex CLI node turn failed: ${formatCodexDisplayText(formatErrorMessage(error))}`,
        },
      };
    }
  }
  try {
    const result = await enqueueBoundTurn(data.bindingId, () =>
      runBoundTurnWithMissingThreadRecovery({
        bindingStore: options.bindingStore,
        data,
        prompt,
        event,
        config: options.config,
        sessionKey: event.sessionKey ?? ctx.sessionKey,
        pluginConfig: options.pluginConfig,
        timeoutMs: options.timeoutMs,
      }),
    );
    return { handled: true, reply: result.reply };
  } catch (error) {
    return {
      handled: true,
      reply: {
        text: `Codex app-server turn failed: ${formatCodexDisplayText(formatErrorMessage(error))}`,
      },
    };
  }
}

async function handleCodexConversationBindingResolved(
  event: PluginConversationBindingResolvedEvent,
  options: { bindingStore: CodexAppServerBindingStore },
): Promise<void> {
  if (event.status !== "denied") {
    return;
  }
  const data = readCodexConversationBindingDataRecord(event.request.data ?? {});
  if (!data || data.kind !== "codex-app-server-session") {
    return;
  }
  const identity = conversationBindingIdentity(data);
  const binding = await options.bindingStore.read(identity);
  assertCodexBindingMayBeReplaced(binding, "clearing a denied conversation binding");
  if (!data.start?.id || binding?.conversationStartId === data.start.id) {
    await options.bindingStore.mutate(identity, { kind: "clear" });
  }
}

type CodexThreadBindingParams = {
  pluginConfig?: unknown;
  bindingStore: CodexAppServerBindingStore;
  identity: CodexAppServerBindingIdentity;
  workspaceDir: string;
  agentDir?: string;
  model?: string;
  modelProvider?: string;
  authProfileId?: string;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  sandbox?: CodexAppServerSandboxMode;
  serviceTier?: CodexServiceTier;
  config?: CodexAppServerAuthProfileLookup["config"];
  agentId?: string;
  sessionKey?: string;
};

type ConversationAppServerRuntime = Awaited<ReturnType<typeof resolveConversationAppServerRuntime>>;

type CodexThreadBindingRuntime = ConversationAppServerRuntime & {
  agentLookup: ReturnType<typeof buildAgentLookup>;
  client: Awaited<ReturnType<typeof getLeasedSharedCodexAppServerClient>>;
  clientLease: CodexAppServerClientLease;
  clientOptions: CodexAppServerClientOptions;
  model?: string;
  modelProvider?: string;
};

async function resolveThreadBindingRuntime(
  params: CodexThreadBindingParams,
): Promise<CodexThreadBindingRuntime> {
  const agentLookup = buildAgentLookup({ agentDir: params.agentDir, config: params.config });
  const modelProvider = resolveThreadRequestModelProvider({
    authProfileId: params.authProfileId,
    modelProvider: params.modelProvider,
    ...agentLookup,
  });
  const modelSelection = resolveOptionalThreadRequestModelSelection({
    model: params.model,
    modelProvider,
    authProfileId: params.authProfileId,
    ...agentLookup,
  });
  const reviewerModelProvider = resolveModelBackedReviewerPolicyProvider({
    authProfileId: params.authProfileId,
    modelProvider: params.modelProvider,
    ...agentLookup,
  });
  const { execPolicy, runtime } = await resolveConversationAppServerRuntime({
    pluginConfig: params.pluginConfig,
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    modelProvider: reviewerModelProvider,
    model: params.model,
    agentDir: params.agentDir,
  });
  const modelScopedRuntime = resolveCodexAppServerForModelProvider({
    appServer: runtime,
    provider: reviewerModelProvider,
    model: params.model,
    config: params.config,
    env: process.env,
    agentDir: params.agentDir,
  });
  assertNativeConversationApprovalPolicySupported({
    execPolicy,
    approvalPolicy: execPolicy?.touched
      ? modelScopedRuntime.approvalPolicy
      : (params.approvalPolicy ?? modelScopedRuntime.approvalPolicy),
    approvalsReviewer: modelScopedRuntime.approvalsReviewer,
    modelBackedApprovalsReviewerUnavailable: !canUseCodexModelBackedApprovalsReviewerForModel({
      modelProvider: reviewerModelProvider,
      model: params.model,
      config: params.config,
      env: process.env,
      agentDir: params.agentDir,
    }),
  });
  const clientOptions = {
    startOptions: runtime.start,
    timeoutMs: runtime.requestTimeoutMs,
    authProfileId: params.authProfileId,
    ...agentLookup,
  } satisfies CodexAppServerClientOptions;
  const client = await getLeasedSharedCodexAppServerClient(clientOptions);
  return {
    execPolicy,
    runtime: modelScopedRuntime,
    agentLookup,
    model: modelSelection?.model,
    modelProvider: modelSelection?.modelProvider ?? modelProvider,
    client,
    clientLease: { client },
    clientOptions,
  };
}

function buildThreadRequestRuntimeOptions(
  params: CodexThreadBindingParams,
  resolved: CodexThreadBindingRuntime,
): {
  approvalPolicy: ConversationAppServerRuntime["runtime"]["approvalPolicy"];
  approvalsReviewer: ConversationAppServerRuntime["runtime"]["approvalsReviewer"];
  sandbox?: ConversationAppServerRuntime["runtime"]["sandbox"];
  serviceTier?: CodexServiceTier;
  config?: JsonObject;
} {
  const serviceTier = params.serviceTier ?? resolved.runtime.serviceTier;
  const sandbox = resolved.execPolicy?.touched
    ? resolved.runtime.sandbox
    : (params.sandbox ?? resolved.runtime.sandbox);
  return {
    approvalPolicy: resolved.execPolicy?.touched
      ? resolved.runtime.approvalPolicy
      : (params.approvalPolicy ?? resolved.runtime.approvalPolicy),
    approvalsReviewer: resolved.runtime.approvalsReviewer,
    ...codexConversationSandboxOrPermissions(resolved.runtime, sandbox),
    ...(serviceTier ? { serviceTier } : {}),
  };
}

function codexConversationSandboxOrPermissions(
  runtime: Pick<ConversationAppServerRuntime["runtime"], "networkProxy">,
  sandbox: ConversationAppServerRuntime["runtime"]["sandbox"],
): {
  sandbox?: ConversationAppServerRuntime["runtime"]["sandbox"];
  config?: JsonObject;
} {
  const networkProxy = runtime.networkProxy;
  if (networkProxy) {
    return {
      config: networkProxy.configPatch,
    };
  }
  return { sandbox };
}

async function requestNewConversationBindingThread(
  params: CodexThreadBindingParams,
  resolved: CodexThreadBindingRuntime,
): Promise<CodexThreadStartResponse> {
  return await withLeasedCodexAppServerClientStartSelectionRetry({
    lease: resolved.clientLease,
    options: resolved.clientOptions,
    run: async (client, requestOptions) =>
      await client.request(
        "thread/start",
        {
          cwd: params.workspaceDir,
          ...(resolved.model ? { model: resolved.model } : {}),
          ...(resolved.modelProvider ? { modelProvider: resolved.modelProvider } : {}),
          personality: CODEX_NATIVE_PERSONALITY_NONE,
          ...buildThreadRequestRuntimeOptions(params, resolved),
          developerInstructions: CODEX_CONVERSATION_THREAD_DEVELOPER_INSTRUCTIONS,
          experimentalRawEvents: true,
        },
        requestOptions,
      ),
    onClientChange: (client) => {
      resolved.client = client;
    },
  });
}

async function writeThreadBindingFromResponse(
  params: CodexThreadBindingParams,
  resolved: CodexThreadBindingRuntime,
  response: CodexThreadResumeResponse | CodexThreadStartResponse,
): Promise<void> {
  const current = await params.bindingStore.read(params.identity);
  assertCodexBindingMayBeReplaced(current, "storing a conversation-bound Codex thread");
  const runtimeApprovalPolicy =
    typeof resolved.runtime.approvalPolicy === "string"
      ? resolved.runtime.approvalPolicy
      : undefined;
  const committed = await params.bindingStore.mutate(params.identity, {
    kind: "set",
    binding: {
      threadId: response.thread.id,
      clientId: resolved.client.getInstanceId(),
      cwd: response.thread.cwd ?? params.workspaceDir,
      authProfileId: params.authProfileId,
      model: response.model ?? resolved.model ?? params.model,
      modelProvider: normalizeCodexAppServerBindingModelProvider({
        authProfileId: params.authProfileId,
        modelProvider: response.modelProvider ?? resolved.modelProvider ?? params.modelProvider,
        ...resolved.agentLookup,
      }),
      approvalPolicy: resolved.execPolicy?.touched
        ? runtimeApprovalPolicy
        : (params.approvalPolicy ?? runtimeApprovalPolicy),
      sandbox: resolved.execPolicy?.touched
        ? resolved.runtime.sandbox
        : (params.sandbox ?? resolved.runtime.sandbox),
      serviceTier: params.serviceTier ?? resolved.runtime.serviceTier ?? undefined,
      networkProxyProfileName: resolved.runtime.networkProxy?.profileName,
      networkProxyConfigFingerprint: resolved.runtime.networkProxy?.configFingerprint,
    },
  });
  if (!committed) {
    throw new Error("Codex conversation binding changed while storing its thread.");
  }
}

async function attachExistingThread(
  params: CodexThreadBindingParams & {
    threadId: string;
  },
): Promise<void> {
  const current = await params.bindingStore.read(params.identity);
  assertCodexBindingMayBeReplaced(current, "attaching a conversation-bound Codex thread");
  const resolved = await resolveThreadBindingRuntime(params);
  try {
    // Codex applies network-proxy permission profiles at thread/start. Resuming
    // an arbitrary existing thread cannot prove that profile is active.
    const response: CodexThreadResumeResponse | CodexThreadStartResponse = resolved.runtime
      .networkProxy
      ? await requestNewConversationBindingThread(params, resolved)
      : await withLeasedCodexAppServerClientStartSelectionRetry({
          lease: resolved.clientLease,
          options: resolved.clientOptions,
          run: async (client, requestOptions) =>
            await client.request(
              CODEX_CONTROL_METHODS.resumeThread,
              {
                threadId: params.threadId,
                ...(resolved.model ? { model: resolved.model } : {}),
                ...(resolved.modelProvider ? { modelProvider: resolved.modelProvider } : {}),
                personality: CODEX_NATIVE_PERSONALITY_NONE,
                ...buildThreadRequestRuntimeOptions(params, resolved),
              },
              requestOptions,
            ),
          onClientChange: (client) => {
            resolved.client = client;
          },
        });
    await writeThreadBindingFromResponse(params, resolved, response);
  } finally {
    releaseCodexAppServerClientLease(resolved.clientLease);
  }
}

async function createThread(params: CodexThreadBindingParams): Promise<void> {
  const current = await params.bindingStore.read(params.identity);
  assertCodexBindingMayBeReplaced(current, "creating a conversation-bound Codex thread");
  const resolved = await resolveThreadBindingRuntime(params);
  try {
    const response = await requestNewConversationBindingThread(params, resolved);
    await writeThreadBindingFromResponse(params, resolved, response);
  } finally {
    releaseCodexAppServerClientLease(resolved.clientLease);
  }
}

async function runBoundTurn(params: {
  bindingStore: CodexAppServerBindingStore;
  data: CodexAppServerConversationBindingData;
  prompt: string;
  event: PluginHookInboundClaimEvent;
  pluginConfig?: unknown;
  config?: CodexConversationConfig;
  sessionKey?: string;
  timeoutMs?: number;
}): Promise<BoundTurnResult> {
  const agentLookup = buildAgentLookup({ agentDir: params.data.agentDir, config: params.config });
  const identity = conversationBindingIdentity(params.data);
  const binding = await params.bindingStore.read(identity);
  if (!binding?.threadId) {
    throw new Error("bound Codex conversation has no thread binding");
  }
  assertCodexBindingMayBeReplaced(binding, "running a conversation-bound Codex thread");
  let threadId = binding.threadId;
  const workspaceDir = binding.cwd || params.data.workspaceDir;
  const reviewerModelProvider = resolveModelBackedReviewerPolicyProvider({
    authProfileId: binding.authProfileId,
    modelProvider: binding.modelProvider,
    ...agentLookup,
  });
  const { execPolicy, runtime } = await resolveConversationAppServerRuntime({
    pluginConfig: params.pluginConfig,
    config: params.config,
    agentId: params.data.agentId,
    sessionKey: params.sessionKey,
    workspaceDir,
    modelProvider: reviewerModelProvider,
    model: binding.model,
    agentDir: params.data.agentDir,
  });
  const modelScopedRuntime = resolveCodexAppServerForModelProvider({
    appServer: runtime,
    provider: reviewerModelProvider,
    model: binding.model,
    config: params.config,
    env: process.env,
    agentDir: params.data.agentDir,
  });
  const modelBackedApprovalsReviewerUnavailable = !canUseCodexModelBackedApprovalsReviewerForModel({
    modelProvider: reviewerModelProvider,
    model: binding.model,
    config: params.config,
    env: process.env,
    agentDir: params.data.agentDir,
  });
  const useModelScopedPolicy =
    execPolicy?.touched === true || modelBackedApprovalsReviewerUnavailable;
  const approvalPolicy = useModelScopedPolicy
    ? modelScopedRuntime.approvalPolicy
    : (binding.approvalPolicy ?? modelScopedRuntime.approvalPolicy);
  const sandbox = useModelScopedPolicy
    ? modelScopedRuntime.sandbox
    : (binding.sandbox ?? modelScopedRuntime.sandbox);
  const permissionProfile = modelScopedRuntime.networkProxy?.profileName;
  const networkProxyConfigFingerprint = modelScopedRuntime.networkProxy?.configFingerprint;
  const networkProxyBindingChanged =
    binding.networkProxyProfileName !== permissionProfile ||
    binding.networkProxyConfigFingerprint !== networkProxyConfigFingerprint;
  const serviceTier = binding.serviceTier ?? runtime.serviceTier;
  let useStickyNetworkProfile =
    permissionProfile !== undefined &&
    binding.networkProxyProfileName === permissionProfile &&
    binding.networkProxyConfigFingerprint === networkProxyConfigFingerprint;
  assertNativeConversationApprovalPolicySupported({
    execPolicy,
    approvalPolicy,
    approvalsReviewer: modelScopedRuntime.approvalsReviewer,
    modelBackedApprovalsReviewerUnavailable,
  });
  const modelSelection = binding.model
    ? resolveCodexAppServerRequestModelSelection({
        model: binding.model,
        modelProvider: binding.modelProvider,
        authProfileId: binding.authProfileId,
        ...agentLookup,
      })
    : undefined;

  const clientOptions = {
    startOptions: runtime.start,
    timeoutMs: runtime.requestTimeoutMs,
    authProfileId: binding.authProfileId,
    ...agentLookup,
  } satisfies CodexAppServerClientOptions;
  let client = await getLeasedSharedCodexAppServerClient(clientOptions);
  const clientLease: CodexAppServerClientLease = { client };
  let notificationCleanup: () => void = () => undefined;
  let requestCleanup: () => void = () => undefined;
  try {
    if (networkProxyBindingChanged) {
      const response = assertCodexThreadStartResponse(
        await withLeasedCodexAppServerClientStartSelectionRetry({
          lease: clientLease,
          options: clientOptions,
          run: async (requestClient, requestOptions) =>
            await requestClient.request(
              "thread/start",
              {
                cwd: workspaceDir,
                ...(modelSelection?.model ? { model: modelSelection.model } : {}),
                ...(modelSelection?.modelProvider
                  ? { modelProvider: modelSelection.modelProvider }
                  : {}),
                personality: CODEX_NATIVE_PERSONALITY_NONE,
                approvalPolicy,
                approvalsReviewer: modelScopedRuntime.approvalsReviewer,
                ...(modelScopedRuntime.networkProxy
                  ? { config: modelScopedRuntime.networkProxy.configPatch }
                  : { sandbox }),
                ...(serviceTier ? { serviceTier } : {}),
                developerInstructions: CODEX_CONVERSATION_THREAD_DEVELOPER_INSTRUCTIONS,
                experimentalRawEvents: true,
              },
              requestOptions,
            ),
          onClientChange: (nextClient) => {
            client = nextClient;
          },
        }),
      );
      threadId = response.thread.id;
      const committed = await params.bindingStore.mutate(identity, {
        kind: "set",
        binding: {
          threadId,
          clientId: client.getInstanceId(),
          cwd: response.thread.cwd ?? workspaceDir,
          authProfileId: binding.authProfileId,
          model: response.model ?? modelSelection?.model ?? binding.model,
          modelProvider: normalizeCodexAppServerBindingModelProvider({
            authProfileId: binding.authProfileId,
            modelProvider:
              response.modelProvider ?? modelSelection?.modelProvider ?? binding.modelProvider,
            ...agentLookup,
          }),
          approvalPolicy: typeof approvalPolicy === "string" ? approvalPolicy : undefined,
          sandbox,
          serviceTier: serviceTier ?? undefined,
          networkProxyProfileName: modelScopedRuntime.networkProxy?.profileName,
          networkProxyConfigFingerprint: modelScopedRuntime.networkProxy?.configFingerprint,
          conversationStartId: binding.conversationStartId,
          conversationSourceTransferComplete: binding.conversationSourceTransferComplete,
          historyCoveredThrough: binding.historyCoveredThrough,
        },
      });
      if (!committed) {
        throw new Error("Codex conversation binding changed while rotating its thread.");
      }
      useStickyNetworkProfile = modelScopedRuntime.networkProxy !== undefined;
    } else if (binding.clientId !== client.getInstanceId()) {
      const response = await withLeasedCodexAppServerClientStartSelectionRetry({
        lease: clientLease,
        options: clientOptions,
        run: async (requestClient, requestOptions) =>
          await resumeCodexAppServerThread({
            client: requestClient,
            abandonClient: async () => {
              await requestClient.closeAndWait();
            },
            request: {
              threadId,
              ...(modelSelection?.model ? { model: modelSelection.model } : {}),
              ...(modelSelection?.modelProvider
                ? { modelProvider: modelSelection.modelProvider }
                : {}),
              personality: CODEX_NATIVE_PERSONALITY_NONE,
              approvalPolicy,
              approvalsReviewer: modelScopedRuntime.approvalsReviewer,
              ...codexConversationSandboxOrPermissions(modelScopedRuntime, sandbox),
              ...(serviceTier ? { serviceTier } : {}),
            },
            ...requestOptions,
          }),
        onClientChange: (nextClient) => {
          client = nextClient;
        },
      });
      threadId = response.thread.id;
      const committed = await params.bindingStore.mutate(identity, {
        kind: "patch",
        threadId: binding.threadId,
        patch: {
          clientId: client.getInstanceId(),
          cwd: response.thread.cwd ?? binding.cwd,
          model: response.model ?? modelSelection?.model ?? binding.model,
          modelProvider: normalizeCodexAppServerBindingModelProvider({
            authProfileId: binding.authProfileId,
            modelProvider:
              response.modelProvider ?? modelSelection?.modelProvider ?? binding.modelProvider,
            ...agentLookup,
          }),
        },
      });
      if (!committed) {
        throw new Error("Codex conversation binding changed while resuming on a new client.");
      }
    }
    const collector = createCodexConversationTurnCollector(threadId);
    notificationCleanup = client.addNotificationHandler((notification) =>
      collector.handleNotification(notification),
    );
    requestCleanup = client.addRequestHandler(async (request): Promise<JsonValue | undefined> => {
      if (request.method === "item/tool/call") {
        return {
          contentItems: [
            {
              type: "inputText",
              text: "OpenClaw native Codex conversation binding does not expose dynamic OpenClaw tools yet.",
            },
          ],
          success: false,
        };
      }
      if (
        request.method === "item/commandExecution/requestApproval" ||
        request.method === "item/fileChange/requestApproval"
      ) {
        return {
          decision: "decline",
          reason:
            "OpenClaw native Codex conversation binding cannot route interactive approvals yet; use the Codex harness or explicit /acp spawn codex for that workflow.",
        };
      }
      if (request.method === "item/permissions/requestApproval") {
        return { permissions: {}, scope: "turn" };
      }
      if (request.method.includes("requestApproval")) {
        return {
          decision: "decline",
          reason:
            "OpenClaw native Codex conversation binding cannot route interactive approvals yet; use the Codex harness or explicit /acp spawn codex for that workflow.",
        };
      }
      return undefined;
    });
    const response: CodexTurnStartResponse = await client.request(
      "turn/start",
      {
        threadId,
        input: buildCodexConversationTurnInput({
          prompt: params.prompt,
          event: params.event,
        }),
        cwd: workspaceDir,
        approvalPolicy,
        approvalsReviewer: modelScopedRuntime.approvalsReviewer,
        ...(useStickyNetworkProfile
          ? {}
          : { sandboxPolicy: codexSandboxPolicyForTurn(sandbox, workspaceDir) }),
        ...(modelSelection?.model ? { model: modelSelection.model } : {}),
        personality: CODEX_NATIVE_PERSONALITY_NONE,
        ...(serviceTier ? { serviceTier } : {}),
      },
      { timeoutMs: runtime.requestTimeoutMs },
    );
    const turnId = response.turn.id;
    const activeCleanup = trackCodexConversationActiveTurn({
      identity,
      client,
      threadId,
      turnId,
    });
    collector.setTurnId(turnId);
    const completion = await collector
      .wait({
        timeoutMs: params.timeoutMs ?? DEFAULT_BOUND_TURN_TIMEOUT_MS,
      })
      .finally(activeCleanup);
    const replyText = completion.replyText.trim();
    return {
      reply: {
        text: replyText || "Codex completed without a text reply.",
      },
    };
  } finally {
    notificationCleanup();
    requestCleanup();
    releaseCodexAppServerClientLease(clientLease);
  }
}

function assertNativeConversationApprovalPolicySupported(params: {
  execPolicy?: OpenClawExecPolicyForCodexAppServer;
  approvalPolicy: ReturnType<typeof resolveCodexAppServerRuntimeOptions>["approvalPolicy"];
  approvalsReviewer: ReturnType<typeof resolveCodexAppServerRuntimeOptions>["approvalsReviewer"];
  modelBackedApprovalsReviewerUnavailable: boolean;
}): void {
  if (
    params.approvalPolicy !== "never" &&
    (params.execPolicy?.touched === true ||
      (params.modelBackedApprovalsReviewerUnavailable && params.approvalsReviewer === "user"))
  ) {
    throw new Error(NATIVE_CONVERSATION_INTERACTIVE_APPROVALS_UNAVAILABLE);
  }
}

async function runBoundTurnWithMissingThreadRecovery(params: {
  bindingStore: CodexAppServerBindingStore;
  data: CodexAppServerConversationBindingData;
  prompt: string;
  event: PluginHookInboundClaimEvent;
  pluginConfig?: unknown;
  config?: CodexConversationConfig;
  sessionKey?: string;
  timeoutMs?: number;
}): Promise<BoundTurnResult> {
  await prepareConversationBinding(params);
  try {
    return await runBoundTurn(params);
  } catch (error) {
    if (!isCodexThreadNotFoundError(error)) {
      throw error;
    }
    await prepareConversationBinding(params, { forceNew: true });
    return await runBoundTurn(params);
  }
}

async function prepareConversationBinding(
  params: {
    bindingStore: CodexAppServerBindingStore;
    data: CodexAppServerConversationBindingData;
    pluginConfig?: unknown;
    config?: CodexConversationConfig;
    sessionKey?: string;
  },
  options: { forceNew?: boolean } = {},
): Promise<void> {
  const identity = conversationBindingIdentity(params.data);
  await params.bindingStore.withLease(identity, async () => {
    const current = await params.bindingStore.read(identity);
    const requested =
      params.data.start && current?.conversationStartId !== params.data.start.id
        ? params.data.start
        : undefined;
    if (current && !requested && !options.forceNew) {
      return;
    }
    const sourceIdentity = params.data.source
      ? sessionBindingIdentity({
          agentId: params.data.source.agentId,
          sessionId: params.data.source.sessionId,
          sessionKey: params.data.source.sessionKey,
          config: params.config,
        })
      : undefined;
    const sourceBinding = sourceIdentity
      ? await params.bindingStore.read(sourceIdentity)
      : undefined;
    assertCodexBindingMayBeReplaced(current, "initializing a conversation-bound Codex thread");
    assertCodexBindingMayBeReplaced(
      sourceBinding,
      "transferring a session into a conversation-bound Codex thread",
    );
    const inherited = current ?? sourceBinding;
    const execPolicy = resolveConversationExecPolicy({
      config: params.config,
      agentId: params.data.agentId,
      sessionKey: params.sessionKey,
    });
    const agentLookup = buildAgentLookup({ agentDir: params.data.agentDir, config: params.config });
    const bindingParams: CodexThreadBindingParams = {
      bindingStore: params.bindingStore,
      identity,
      pluginConfig: params.pluginConfig,
      workspaceDir: requested
        ? params.data.workspaceDir
        : (inherited?.cwd ?? params.data.workspaceDir),
      ...agentLookup,
      model: requested?.model ?? inherited?.model,
      modelProvider: requested?.modelProvider ?? inherited?.modelProvider,
      authProfileId: requested?.authProfileId ?? inherited?.authProfileId,
      approvalPolicy: execPolicy.touched ? undefined : inherited?.approvalPolicy,
      sandbox: execPolicy.touched ? undefined : inherited?.sandbox,
      serviceTier: inherited?.serviceTier,
      config: params.config,
      sessionKey: params.sessionKey,
      agentId: params.data.agentId,
    };
    const threadId = requested?.threadId ?? (!current ? params.data.source?.threadId : undefined);
    if (threadId && !options.forceNew) {
      await attachExistingThread({ ...bindingParams, threadId });
    } else {
      await createThread(bindingParams);
    }
    const stored = await params.bindingStore.read(identity);
    if (!stored) {
      throw new Error("Codex conversation binding disappeared while initializing its thread.");
    }
    if (sourceIdentity && params.data.source && !current?.conversationSourceTransferComplete) {
      await params.bindingStore.withLease(sourceIdentity, async () => {
        const source = await params.bindingStore.read(sourceIdentity);
        if (source && source.threadId === params.data.source?.threadId) {
          await params.bindingStore.mutate(sourceIdentity, {
            kind: "clear",
            threadId: source.threadId,
          });
        }
      });
    }
    const patched = await params.bindingStore.mutate(identity, {
      kind: "patch",
      threadId: stored.threadId,
      patch: {
        ...(params.data.start ? { conversationStartId: params.data.start.id } : {}),
        ...(sourceIdentity ? { conversationSourceTransferComplete: true } : {}),
      },
    });
    if (!patched) {
      throw new Error("Codex conversation binding changed while initializing its thread.");
    }
  });
}

function resolveConversationExecPolicy(params: {
  config?: CodexConversationConfig;
  agentId?: string;
  sessionKey?: string;
}) {
  const agentId =
    params.agentId ??
    (params.config
      ? resolveSessionAgentIds({
          sessionKey: params.sessionKey,
          config: params.config,
        }).sessionAgentId
      : undefined);
  return resolveOpenClawExecPolicyForCodexAppServer({
    config: params.config,
    agentId,
    execOverrides: readSessionExecOverrides({
      config: params.config,
      agentId,
      sessionKey: params.sessionKey,
    }),
    approvals: loadExecApprovals(),
  });
}

function readSessionExecOverrides(params: {
  config?: CodexConversationConfig;
  agentId?: string;
  sessionKey?: string;
}): { security?: string; ask?: string } | undefined {
  const sessionKey = params.sessionKey?.trim();
  if (!params.config || !sessionKey) {
    return undefined;
  }
  if (
    !canReadSessionExecOverrides({
      config: params.config,
      agentId: params.agentId,
      sessionKey,
    })
  ) {
    return undefined;
  }
  const storePath = resolveStorePath(params.config.session?.store, { agentId: params.agentId });
  const entry = getSessionEntry({
    storePath,
    sessionKey,
    readConsistency: "latest",
  });
  if (!entry?.execSecurity && !entry?.execAsk) {
    return undefined;
  }
  return {
    security: entry.execSecurity,
    ask: entry.execAsk,
  };
}

function canReadSessionExecOverrides(params: {
  config: ResolvedCodexConversationConfig;
  agentId?: string;
  sessionKey: string;
}): boolean {
  const agentId = normalizeAgentIdOrDefault(params.agentId);
  if (!agentId) {
    return true;
  }
  const sessionAgentId = parseAgentIdFromSessionKey(params.sessionKey);
  if (!sessionAgentId) {
    return isDefaultAgentSessionKeyForAgent({ config: params.config, agentId });
  }
  return sessionAgentId === agentId;
}

function parseAgentIdFromSessionKey(sessionKey?: string): string | undefined {
  const raw = sessionKey?.trim();
  if (!raw) {
    return undefined;
  }
  const parts = raw.toLowerCase().split(":").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "agent" || !parts[2]) {
    return undefined;
  }
  return normalizeAgentIdOrDefault(parts[1]);
}

function isDefaultAgentSessionKeyForAgent(params: {
  config: ResolvedCodexConversationConfig;
  agentId: string;
}): boolean {
  return normalizeAgentId(params.agentId) === resolveDefaultPolicyAgentId(params.config);
}

function resolveDefaultPolicyAgentId(config: ResolvedCodexConversationConfig): string {
  const agents = (config.agents?.list ?? []).filter(
    (
      entry,
    ): entry is NonNullable<
      NonNullable<ResolvedCodexConversationConfig["agents"]>["list"]
    >[number] => entry !== null && typeof entry === "object",
  );
  const defaultEntry = agents.find((entry) => entry?.default) ?? agents[0];
  return normalizeAgentId(defaultEntry?.id);
}

function normalizeAgentIdOrDefault(value?: string | null): string | undefined {
  const normalized = normalizeAgentId(value);
  return normalized === DEFAULT_AGENT_ID && !(value ?? "").trim() ? undefined : normalized;
}

function normalizeAgentId(value?: string | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return DEFAULT_AGENT_ID;
  }
  const normalized = trimmed.toLowerCase();
  if (VALID_AGENT_ID_PATTERN.test(trimmed)) {
    return normalized;
  }
  return (
    normalized
      .replace(INVALID_AGENT_ID_CHARS_PATTERN, "-")
      .replace(LEADING_DASH_PATTERN, "")
      .replace(TRAILING_DASH_PATTERN, "")
      .slice(0, 64) || DEFAULT_AGENT_ID
  );
}

function isCodexThreadNotFoundError(error: unknown): boolean {
  const message = formatErrorMessage(error);
  return (
    /\bthread not found:/iu.test(message) ||
    /\bbound Codex conversation has no thread binding\b/u.test(message)
  );
}

function enqueueBoundTurn<T>(key: string, run: () => Promise<T>): Promise<T> {
  return getGlobalState().queue.enqueue(key, run);
}

function resolveThreadRequestModelProvider(params: {
  authProfileId?: string;
  modelProvider?: string;
  agentDir?: string;
  config?: CodexAppServerAuthProfileLookup["config"];
}): string | undefined {
  const modelProvider = params.modelProvider?.trim();
  if (!modelProvider || modelProvider.toLowerCase() === "codex") {
    return undefined;
  }
  if (isCodexAppServerNativeAuthProfile(params) && modelProvider.toLowerCase() === "openai") {
    return undefined;
  }
  return modelProvider.toLowerCase() === "openai" ? "openai" : modelProvider;
}

function resolveOptionalThreadRequestModelSelection(params: {
  model?: string;
  modelProvider?: string;
  authProfileId?: string;
  agentDir?: string;
  config?: CodexAppServerAuthProfileLookup["config"];
}): { model: string; modelProvider?: string } | undefined {
  if (!params.model?.trim()) {
    return undefined;
  }
  return resolveCodexAppServerRequestModelSelection({
    model: params.model,
    modelProvider: params.modelProvider,
    authProfileId: params.authProfileId,
    agentDir: params.agentDir,
    config: params.config,
  });
}

function resolveModelBackedReviewerPolicyProvider(params: {
  authProfileId?: string;
  modelProvider?: string;
  agentDir?: string;
  config?: CodexAppServerAuthProfileLookup["config"];
}): string | undefined {
  const modelProvider = params.modelProvider?.trim();
  if (modelProvider && modelProvider.toLowerCase() !== "codex") {
    return modelProvider.toLowerCase() === "openai" ? "openai" : modelProvider;
  }
  return isCodexAppServerNativeAuthProfile(params) ? "openai" : undefined;
}

function buildAgentLookup(params: {
  agentDir?: string;
  config?: CodexAppServerAuthProfileLookup["config"];
}): Pick<CodexAppServerAuthProfileLookup, "agentDir" | "config"> {
  const agentDir = params.agentDir?.trim();
  return {
    ...(agentDir ? { agentDir } : {}),
    ...(params.config ? { config: params.config } : {}),
  };
}

function conversationBindingIdentity(
  data: Pick<CodexAppServerConversationBindingData, "bindingId">,
): CodexAppServerBindingIdentity {
  return { kind: "conversation", bindingId: data.bindingId };
}

export const codexConversationBindingRuntime = {
  startThread: startCodexConversationThread,
  handleInboundClaim: handleCodexConversationInboundClaim,
  handleBindingResolved: handleCodexConversationBindingResolved,
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
