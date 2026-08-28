import {
  embeddedAgentLog,
  formatErrorMessage,
  resolveActiveEmbeddedRunSessionId,
  resolveSandboxContext,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { resolveSessionAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { loadExecApprovals } from "openclaw/plugin-sdk/exec-approvals-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type {
  PluginConversationBindingResolvedEvent,
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import {
  getSessionEntry,
  resolveStorePath,
  resolveTranscriptSessionKeyBySessionId,
} from "openclaw/plugin-sdk/session-store-runtime";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import { resolveCodexAppServerForModelProvider } from "./app-server/app-server-policy.js";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  closeCodexStartupClientBestEffort,
  interruptCodexTurnAndWaitBestEffort,
  isCodexAppServerUnsafeSubscriptionError,
  retireUnsafeCodexTurnClientBestEffort,
  unsubscribeCodexThreadBestEffort,
} from "./app-server/attempt-client-cleanup.js";
import { resolveCodexAppServerAuthProfileIdForAgent } from "./app-server/auth-bridge.js";
import {
  consumeCodexAppServerLiveThread,
  hasCodexAppServerLiveThread,
  isCodexAppServerClientRuntimeLive,
  isCodexAppServerLiveThreadClaimed,
  releaseCodexAppServerLiveThread,
  type CodexAppServerLiveThreadOwnership,
} from "./app-server/client-runtime.js";
import {
  isCodexAppServerIndeterminateRequestCancellationError,
  isCodexAppServerOverloadError,
  type CodexAppServerClient,
} from "./app-server/client.js";
import {
  canUseCodexModelBackedApprovalsReviewerForModel,
  codexSandboxPolicyForTurn,
  readCodexPluginConfig,
  readCodexRequirementsToml,
  resolveOpenClawExecPolicyForCodexAppServer,
  resolveCodexAppServerRuntimeOptions,
} from "./app-server/config.js";
import {
  buildDisabledAppsConfigPatch,
  mergeCodexThreadConfigs,
} from "./app-server/plugin-thread-config.js";
import { buildCodexProjectDocThreadConfig } from "./app-server/project-doc-thread-config.js";
import {
  assertCodexThreadAcceptsDirectInput,
  assertCodexThreadStartResponse,
  CodexThreadDirectInputError,
} from "./app-server/protocol-validators.js";
import type {
  CodexServiceTier,
  CodexThreadResumeResponse,
  CodexThreadStartParams,
  CodexThreadStartResponse,
  CodexTurnStartResponse,
  JsonObject,
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
  applyCodexSessionPermissionPolicy,
  CODEX_SESSION_PERMISSION_EXEC_MODES,
  resolveCodexSessionPermissionCwd,
} from "./app-server/session-permission-policy.js";
import {
  getLeasedSharedCodexAppServerClient,
  retainSharedCodexAppServerClientByInstanceId,
  releaseCodexAppServerClientLease,
  withLeasedCodexAppServerClientStartSelectionRetry,
  type CodexAppServerClientLease,
  type CodexAppServerClientOptions,
  type CodexAppServerLeasedRequestOptions,
} from "./app-server/shared-client.js";
import {
  CODEX_NATIVE_PERSONALITY_NONE,
  resolveCodexAppServerRequestModelSelection,
} from "./app-server/thread-lifecycle.js";
import {
  isSameCodexAppServerThreadOwner,
  releaseCodexAppServerBindingSubscription,
  retainCodexAppServerBindingSubscription,
  retireCodexConversationThreadBinding,
  rollbackCodexAppServerBindingSubscription,
  withCodexConversationThreadActivity,
  withExclusiveCodexAppServerThread,
} from "./app-server/thread-ownership.js";
import { resumeCodexAppServerThread } from "./app-server/thread-resume.js";
import { projectBoundedCodexVisibleSessionHistory } from "./app-server/transcript-history-projection.js";
import {
  getCodexAppServerTurnRouter,
  type CodexThreadRouteReservation,
} from "./app-server/turn-router.js";
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
import {
  CodexConversationTurnTimeoutError,
  createCodexConversationTurnCollector,
} from "./conversation-turn-collector.js";
import { buildCodexConversationTurnInput } from "./conversation-turn-input.js";
import { isIncognitoSessionKey } from "./incognito-session.js";
import { resumeCodexCliSessionOnNode } from "./node-cli-sessions.js";

const DEFAULT_BOUND_TURN_TIMEOUT_MS = 20 * 60_000;
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
  serviceTier?: CodexServiceTier;
};

type BoundTurnResult = {
  reply: ReplyPayload;
};

type CodexConversationConfig = Parameters<
  typeof resolveCodexAppServerAuthProfileIdForAgent
>[0]["config"];
type CodexConversationGlobalState = {
  queue: KeyedAsyncQueue;
};

async function resolveConversationAppServerRuntime(params: {
  pluginConfig?: unknown;
  config?: CodexConversationConfig;
  agentId?: string;
  agentDir?: string;
  sessionKey?: string;
  source?: CodexAppServerConversationBindingData["source"];
  workspaceDir: string;
  modelProvider?: string;
  model?: string;
}): Promise<{
  runtime: ReturnType<typeof resolveCodexAppServerRuntimeOptions>;
  workspaceDir: string;
}> {
  const source = params.source;
  const agentId =
    source?.agentId ??
    params.agentId ??
    (params.config
      ? resolveSessionAgentIds({ sessionKey: params.sessionKey, config: params.config })
          .sessionAgentId
      : undefined);
  const storePath =
    agentId && (source || params.sessionKey)
      ? resolveStorePath(params.config?.session?.store, { agentId })
      : undefined;
  const sessionKey = source
    ? (source.sessionKey ??
      (storePath
        ? resolveTranscriptSessionKeyBySessionId({
            agentId: source.agentId,
            sessionId: source.sessionId,
            storePath,
          })
        : undefined))
    : params.sessionKey;
  const storedEntry =
    sessionKey && storePath
      ? getSessionEntry({ agentId, storePath, sessionKey, readConsistency: "latest" })
      : undefined;
  const entry = !source || storedEntry?.sessionId === source.sessionId ? storedEntry : undefined;
  if (source && !entry) {
    throw new Error(
      "Codex conversation source session is missing or no longer current; rebind this conversation before retrying.",
    );
  }
  const permissionMode = entry?.permissionMode;
  const sessionRoot = permissionMode ? entry?.sessionRoot : undefined;
  // The rootless permission boundary comes from agent config only. A bound
  // thread's requested cwd (/codex bind --cwd) must never widen or become it.
  const agentWorkspaceDir =
    params.config && agentId
      ? resolveAgentWorkspaceDir(params.config, agentId)
      : resolveCodexDefaultWorkspaceDir(params.pluginConfig);
  const execPolicy = resolveOpenClawExecPolicyForCodexAppServer({
    config: params.config,
    agentId,
    permissionMode,
    execOverrides: permissionMode
      ? { mode: CODEX_SESSION_PERMISSION_EXEC_MODES[permissionMode] }
      : undefined,
    approvals: permissionMode === "full" ? undefined : loadExecApprovals(),
  });
  const sandboxForPolicy =
    execPolicy.touched && execPolicy.security === "full" && execPolicy.ask !== "off"
      ? await resolveSandboxContext({
          config: params.config,
          sessionKey,
          workspaceDir: agentWorkspaceDir,
        })
      : undefined;
  const configuredRuntime = resolveCodexAppServerRuntimeOptions({
    pluginConfig: params.pluginConfig,
    execPolicy,
    modelProvider: params.modelProvider,
    model: params.model,
    config: params.config,
    agentDir: params.agentDir,
    openClawSandboxActive: Boolean(sandboxForPolicy?.enabled),
  });
  const canUseAutoReview = canUseCodexModelBackedApprovalsReviewerForModel({
    modelProvider: params.modelProvider,
    model: params.model,
    config: params.config,
    env: process.env,
    agentDir: params.agentDir,
  });
  const runtime = applyCodexSessionPermissionPolicy({
    appServer: configuredRuntime,
    permissionMode,
    sessionRoot,
    defaultRoot: agentWorkspaceDir,
    pluginConfig: readCodexPluginConfig(params.pluginConfig),
    canUseAutoReview,
    requirementsToml: readCodexRequirementsToml({}),
    execMode: execPolicy.mode,
  });
  return {
    runtime,
    workspaceDir: resolveCodexSessionPermissionCwd({
      permissionMode,
      sessionRoot,
      defaultRoot: agentWorkspaceDir,
      requestedCwd: params.workspaceDir,
      fallbackCwd: params.workspaceDir,
    }),
  };
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
  const bindingParams: CodexThreadBindingParams = {
    pluginConfig: params.pluginConfig,
    bindingStore: params.bindingStore,
    identity,
    workspaceDir,
    ...(agentDir ? { agentDir } : {}),
    model: params.model,
    modelProvider: params.modelProvider,
    authProfileId,
    serviceTier: params.serviceTier,
    config: params.config,
    sessionKey: params.sessionKey,
    incognito: isIncognitoSessionKey(params.sessionKey),
    agentId: params.agentId,
  };
  const threadId = params.threadId?.trim();
  if (threadId) {
    await attachExistingThread({ ...bindingParams, threadId });
  } else {
    await bindThread(bindingParams);
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
  const publicBinding = ctx.pluginBinding;
  const data = readCodexConversationBindingData(publicBinding);
  if (!data || !publicBinding) {
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
    const identity = conversationBindingIdentity(data);
    const sessionKey = event.sessionKey ?? ctx.sessionKey;
    // Native ephemeral ownership follows the persisted source, not the
    // destination channel. Shipped v1 bindings have no source to consult.
    const incognito = isIncognitoSessionKey(
      data.source?.sessionKey ?? (data.legacyBinding ? sessionKey : undefined),
    );
    // Start the snapshot before enqueueing, but do not await: yielding here
    // would let detach overtake an already-arrived bound message.
    const queuedOwner = options.bindingStore.read(identity);
    const result = await withCodexConversationThreadActivity(data.bindingId, async () => {
      const currentPublicBinding = getSessionBindingService().resolveByConversation({
        channel: publicBinding.channel,
        accountId: publicBinding.accountId,
        conversationId: publicBinding.conversationId,
        ...(publicBinding.parentConversationId
          ? { parentConversationId: publicBinding.parentConversationId }
          : {}),
      });
      const expected = await queuedOwner;
      const current = await options.bindingStore.read(identity);
      if (
        currentPublicBinding?.bindingId !== publicBinding.bindingId ||
        (expected &&
          (!current ||
            current.threadId !== expected.threadId ||
            current.conversationStartId !== expected.conversationStartId)) ||
        (!expected && current && data.start?.id && current.conversationStartId !== data.start.id)
      ) {
        // Public hooks capture binding data before entering this owner lane;
        // a later detach must never let that stale message recreate its thread.
        return {
          reply: {
            text: "This Codex conversation was detached or changed before its message could run.",
          },
        };
      }
      return await runBoundTurnWithMissingThreadRecovery({
        bindingStore: options.bindingStore,
        data,
        prompt,
        event,
        config: options.config,
        sessionKey,
        incognito,
        pluginConfig: options.pluginConfig,
        timeoutMs: options.timeoutMs,
      });
    });
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
  if (binding && (!data.start?.id || binding.conversationStartId === data.start.id)) {
    await withCodexConversationThreadActivity(identity.bindingId, () =>
      retireCodexConversationThreadBinding({
        bindingStore: options.bindingStore,
        identity,
        expectedThreadId: binding.threadId,
        ...(data.start?.id ? { expectedStartId: data.start.id } : {}),
        ...(isIncognitoSessionKey(data.source?.sessionKey) ? { allowUntracked: true } : {}),
      }),
    );
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
  serviceTier?: CodexServiceTier;
  config?: CodexAppServerAuthProfileLookup["config"];
  agentId?: string;
  sessionKey?: string;
  source?: CodexAppServerConversationBindingData["source"];
  incognito: boolean;
};

type ConversationAppServerRuntime = Awaited<ReturnType<typeof resolveConversationAppServerRuntime>>;

type CodexThreadBindingRuntime = Awaited<ReturnType<typeof resolveThreadBindingRuntime>>;

async function resolveThreadBindingRuntime(params: CodexThreadBindingParams) {
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
  const { runtime, workspaceDir } = await resolveConversationAppServerRuntime({
    pluginConfig: params.pluginConfig,
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    source: params.source,
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
  assertNativeConversationApprovalPolicySupported(modelScopedRuntime);
  const clientOptions = {
    startOptions: runtime.start,
    timeoutMs: runtime.requestTimeoutMs,
    authProfileId: params.authProfileId,
    ...agentLookup,
  } satisfies CodexAppServerClientOptions;
  return {
    runtime: modelScopedRuntime,
    workspaceDir,
    agentLookup,
    model: modelSelection?.model,
    modelProvider: modelSelection?.modelProvider ?? modelProvider,
    clientOptions,
  };
}

function buildConversationThreadRequest(
  resolved: ConversationAppServerRuntime & { model?: string; modelProvider?: string },
  serviceTier?: CodexServiceTier | null,
): CodexThreadStartParams {
  return {
    cwd: resolved.workspaceDir,
    ...(resolved.model ? { model: resolved.model } : {}),
    ...(resolved.modelProvider ? { modelProvider: resolved.modelProvider } : {}),
    personality: CODEX_NATIVE_PERSONALITY_NONE,
    approvalPolicy: resolved.runtime.approvalPolicy,
    approvalsReviewer: resolved.runtime.approvalsReviewer,
    ...(resolved.runtime.sessionRoot
      ? { runtimeWorkspaceRoots: [resolved.runtime.sessionRoot] }
      : {}),
    ...codexConversationSandboxOrPermissions(resolved.runtime, resolved.runtime.sandbox),
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
  // Bound conversations have no native app approval/tool bridge. Disable
  // globally configured Codex apps even when a network profile adds config.
  // Per-app user config overrides apps._default, so the feature kill switch
  // is the only authoritative boundary for this handlerless runtime.
  const disabledApps = mergeCodexThreadConfigs(buildDisabledAppsConfigPatch(), {
    "features.apps": false,
  })!;
  const config = buildCodexProjectDocThreadConfig(
    mergeCodexThreadConfigs(networkProxy?.configPatch, disabledApps),
  );
  return networkProxy ? { config } : { sandbox, config };
}

async function writeThreadBindingFromResponse(
  params: CodexThreadBindingParams,
  resolved: CodexThreadBindingRuntime,
  client: CodexAppServerClient,
  response: CodexThreadResumeResponse | CodexThreadStartResponse,
  requestOptions: () => CodexAppServerLeasedRequestOptions,
): Promise<void> {
  let retained = false;
  let sameOwner = false;
  try {
    const current = await params.bindingStore.read(params.identity);
    assertCodexBindingMayBeReplaced(current, "storing a conversation-bound Codex thread");
    const trackSubscription = !params.incognito && isCodexAppServerClientRuntimeLive(client);
    sameOwner = isSameCodexAppServerThreadOwner(current, {
      threadId: response.thread.id,
      clientId: client.getInstanceId(),
    });
    requestOptions();
    assertCodexThreadAcceptsDirectInput(response.thread);
    if (trackSubscription) {
      retained = await retainCodexAppServerBindingSubscription(client, response.thread.id);
      if (!retained) {
        throw new Error("Codex conversation thread lost its native subscription owner.");
      }
    }
    if (current && !sameOwner) {
      const { assertCurrent } = requestOptions();
      // Keep the old identity visible until its sole native subscription is
      // released; a concurrent owner must not adopt it between clear and cleanup.
      await releaseCodexAppServerBindingSubscription(current, { assertCurrent });
    }
    requestOptions();
    const committed = await params.bindingStore.mutate(
      params.identity,
      {
        kind: "set",
        binding: {
          threadId: response.thread.id,
          clientId: client.getInstanceId(),
          cwd: resolved.workspaceDir,
          authProfileId: params.authProfileId,
          model: response.model ?? resolved.model ?? params.model,
          modelProvider: normalizeCodexAppServerBindingModelProvider({
            authProfileId: params.authProfileId,
            modelProvider: response.modelProvider ?? resolved.modelProvider ?? params.modelProvider,
            ...resolved.agentLookup,
          }),
          serviceTier: params.serviceTier ?? resolved.runtime.serviceTier ?? undefined,
          networkProxyProfileName: resolved.runtime.networkProxy?.profileName,
          networkProxyConfigFingerprint: resolved.runtime.networkProxy?.configFingerprint,
        },
      },
      requestOptions,
    );
    if (!committed) {
      throw new Error("Codex conversation binding changed while storing its thread.");
    }
  } catch (error) {
    // A matching stored binding may already have lost its idle subscription.
    // Keep existing live owners, but never leave an accepted resume untracked.
    if ((retained && !sameOwner) || !hasCodexAppServerLiveThread(client, response.thread.id)) {
      await rollbackCodexAppServerBindingSubscription(client, response.thread.id, retained);
    }
    throw error;
  }
}

async function attachExistingThread(
  params: CodexThreadBindingParams & {
    threadId: string;
  },
): Promise<void> {
  await withExclusiveCodexAppServerThread({
    bindingStore: params.bindingStore,
    identity: params.identity,
    threadId: params.threadId,
    run: () => bindThread(params, params.threadId),
  });
}

async function bindThread(params: CodexThreadBindingParams, threadId?: string): Promise<void> {
  const current = await params.bindingStore.read(params.identity);
  assertCodexBindingMayBeReplaced(current, "binding a conversation-bound Codex thread");
  const resolved = await resolveThreadBindingRuntime(params);
  const clientLease: CodexAppServerClientLease = {
    client: await getLeasedSharedCodexAppServerClient(resolved.clientOptions),
  };
  try {
    await withLeasedCodexAppServerClientStartSelectionRetry({
      lease: clientLease,
      options: resolved.clientOptions,
      run: async (client, requestOptions) => {
        const request = buildConversationThreadRequest(
          resolved,
          params.serviceTier ?? resolved.runtime.serviceTier,
        );
        let response: CodexThreadResumeResponse | CodexThreadStartResponse;
        // Codex applies network-proxy permission profiles at thread/start. Resuming
        // an arbitrary existing thread cannot prove that profile is active.
        if (threadId && !resolved.runtime.networkProxy) {
          if (isCodexAppServerLiveThreadClaimed(client, threadId)) {
            throw new Error(
              `Codex thread ${threadId} has an active run; stop it before binding its conversation.`,
            );
          }
          const { thread } = await client.request(
            "thread/read",
            { threadId, includeTurns: false },
            requestOptions(),
          );
          assertCodexThreadAcceptsDirectInput(thread);
          const { assertCurrent } = requestOptions();
          // Codex ignores resume config while any connection is still
          // subscribed; interactive threads must drop the previous configuration.
          await releaseCodexAppServerLiveThread(client, threadId, assertCurrent);
          if (isCodexAppServerLiveThreadClaimed(client, threadId)) {
            throw new Error(
              `Codex thread ${threadId} has an active run; stop it before binding its conversation.`,
            );
          }
          response = await resumeCodexAppServerThread({
            client,
            abandonClient: () => closeCodexStartupClientBestEffort(client),
            request: { ...request, threadId },
            requestResume: (resumeRequest) =>
              client.request("thread/resume", resumeRequest, requestOptions()),
          });
        } else {
          response = await client.request(
            "thread/start",
            {
              ...request,
              developerInstructions: CODEX_CONVERSATION_THREAD_DEVELOPER_INSTRUCTIONS,
              experimentalRawEvents: true,
              ...(params.incognito ? { ephemeral: true } : {}),
            },
            requestOptions(),
          );
        }
        await writeThreadBindingFromResponse(params, resolved, client, response, requestOptions);
      },
    });
  } finally {
    releaseCodexAppServerClientLease(clientLease);
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
  incognito: boolean;
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
  const requestedWorkspaceDir = binding.cwd || params.data.workspaceDir;
  const reviewerModelProvider = resolveModelBackedReviewerPolicyProvider({
    authProfileId: binding.authProfileId,
    modelProvider: binding.modelProvider,
    ...agentLookup,
  });
  const { runtime, workspaceDir } = await resolveConversationAppServerRuntime({
    pluginConfig: params.pluginConfig,
    config: params.config,
    agentId: params.data.source?.agentId ?? params.data.agentId,
    sessionKey: params.data.legacyBinding ? params.sessionKey : params.data.source?.sessionKey,
    source: params.data.source,
    workspaceDir: requestedWorkspaceDir,
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
  const sessionRoot = modelScopedRuntime.sessionRoot;
  const approvalPolicy = modelScopedRuntime.approvalPolicy;
  const sandbox = modelScopedRuntime.sandbox;
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
  assertNativeConversationApprovalPolicySupported(modelScopedRuntime);
  const modelSelection = binding.model
    ? resolveCodexAppServerRequestModelSelection({
        model: binding.model,
        modelProvider: binding.modelProvider,
        authProfileId: binding.authProfileId,
        ...agentLookup,
      })
    : undefined;
  const threadRequestRuntime = { runtime: modelScopedRuntime, workspaceDir, ...modelSelection };

  const clientOptions = {
    startOptions: runtime.start,
    timeoutMs: runtime.requestTimeoutMs,
    authProfileId: binding.authProfileId,
    ...agentLookup,
  } satisfies CodexAppServerClientOptions;
  let client = await getLeasedSharedCodexAppServerClient(clientOptions);
  const clientLease: CodexAppServerClientLease = { client };
  let activeTurnId: string | undefined;
  let activeTurnCleanup: () => void = () => undefined;
  // Released or retired subscriptions need no further cleanup on that physical client.
  let isolatedSubscriptionClient: CodexAppServerClient | undefined;
  let turnRoute: CodexThreadRouteReservation | undefined;
  let liveThreadOwnership:
    | {
        client: CodexAppServerClient;
        threadId: string;
        ownership: CodexAppServerLiveThreadOwnership;
      }
    | undefined;
  let ownsNativeSubscription = false;
  let turnSucceeded = false;
  const assertResumeInputAllowed = async () => {
    const { thread } = await client.request(
      "thread/read",
      { threadId, includeTurns: false },
      { timeoutMs: runtime.requestTimeoutMs },
    );
    assertCodexThreadAcceptsDirectInput(thread);
  };
  try {
    if (!networkProxyBindingChanged && binding.clientId !== client.getInstanceId()) {
      // A new client may already retain this parent's child; check before claiming it.
      await assertResumeInputAllowed();
    }
    if (!params.incognito && isCodexAppServerClientRuntimeLive(client)) {
      const ownership = await consumeCodexAppServerLiveThread(client, threadId);
      if (ownership) {
        liveThreadOwnership = { client, threadId, ownership };
        ownsNativeSubscription = true;
      }
    }
    if (networkProxyBindingChanged) {
      const response = assertCodexThreadStartResponse(
        await withLeasedCodexAppServerClientStartSelectionRetry({
          lease: clientLease,
          options: clientOptions,
          run: async (requestClient, requestOptions) =>
            await requestClient.request(
              "thread/start",
              {
                ...buildConversationThreadRequest(threadRequestRuntime, serviceTier),
                developerInstructions: CODEX_CONVERSATION_THREAD_DEVELOPER_INSTRUCTIONS,
                experimentalRawEvents: true,
                ...(params.incognito ? { ephemeral: true } : {}),
              },
              requestOptions(),
            ),
          onClientChange: (nextClient) => {
            client = nextClient;
          },
        }),
      );
      threadId = response.thread.id;
      ownsNativeSubscription = true;
      assertCodexThreadAcceptsDirectInput(response.thread);
      if (
        liveThreadOwnership &&
        (liveThreadOwnership.threadId !== threadId || liveThreadOwnership.client !== client)
      ) {
        const previousOwnership = liveThreadOwnership;
        try {
          await previousOwnership.ownership.release(previousOwnership.threadId);
        } catch (error) {
          // A failed unsubscribe leaves the old subscription alive. Restore
          // its exact branded owner before rolling back the new native thread.
          const restored =
            isCodexAppServerClientRuntimeLive(previousOwnership.client) &&
            (await retainCodexAppServerBindingSubscription(
              previousOwnership.client,
              previousOwnership.threadId,
              previousOwnership.ownership,
            ).catch(() => false));
          if (!restored) {
            await closeCodexStartupClientBestEffort(previousOwnership.client);
          }
          liveThreadOwnership = undefined;
          throw error;
        }
        liveThreadOwnership = undefined;
      } else if (binding.threadId !== threadId) {
        await releaseCodexAppServerBindingSubscription(binding);
      }
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
    } else if (
      binding.clientId !== client.getInstanceId() ||
      (isCodexAppServerClientRuntimeLive(client) && !params.incognito && !liveThreadOwnership)
    ) {
      if (binding.clientId === client.getInstanceId()) {
        await assertResumeInputAllowed();
      }
      const response = await withLeasedCodexAppServerClientStartSelectionRetry({
        lease: clientLease,
        options: clientOptions,
        run: async (requestClient, requestOptions) =>
          await resumeCodexAppServerThread({
            client: requestClient,
            onSubscriptionReleased: () => {
              isolatedSubscriptionClient = requestClient;
            },
            abandonClient: async () => {
              await closeCodexStartupClientBestEffort(requestClient);
              isolatedSubscriptionClient = requestClient;
            },
            request: {
              threadId,
              ...buildConversationThreadRequest(threadRequestRuntime, serviceTier),
            },
            requestResume: (request) =>
              requestClient.request("thread/resume", request, requestOptions()),
          }),
        onClientChange: (nextClient) => {
          client = nextClient;
        },
      });
      threadId = response.thread.id;
      ownsNativeSubscription = true;
      assertCodexThreadAcceptsDirectInput(response.thread);
      if (
        !isSameCodexAppServerThreadOwner(binding, {
          threadId,
          clientId: client.getInstanceId(),
        })
      ) {
        // Keep the old physical owner authoritative until unsubscribe succeeds;
        // failed migration then rolls back only the newly resumed connection.
        await releaseCodexAppServerBindingSubscription(binding);
      }
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
    const turnCollector = createCodexConversationTurnCollector(threadId);
    turnRoute = getCodexAppServerTurnRouter(client).reserveThread({
      threadId,
      onNotification: turnCollector.handleNotification,
    });
    // The client denies unclaimed approvals and dynamic tools. Its keyed router owns
    // pre-bind buffering so this conversation cannot claim sibling turn requests.
    turnRoute.armTurn();
    const response: CodexTurnStartResponse = await client.request(
      "turn/start",
      {
        threadId,
        input: buildCodexConversationTurnInput({
          prompt: params.prompt,
          event: params.event,
        }),
        cwd: workspaceDir,
        ...(sessionRoot ? { runtimeWorkspaceRoots: [sessionRoot] } : {}),
        approvalPolicy,
        approvalsReviewer: modelScopedRuntime.approvalsReviewer,
        ...(useStickyNetworkProfile
          ? {}
          : {
              sandboxPolicy: codexSandboxPolicyForTurn(sandbox, sessionRoot ?? workspaceDir),
            }),
        ...(modelSelection?.model ? { model: modelSelection.model } : {}),
        personality: CODEX_NATIVE_PERSONALITY_NONE,
        ...(serviceTier ? { serviceTier } : {}),
      },
      { timeoutMs: runtime.requestTimeoutMs },
    );
    activeTurnId = response.turn.id;
    activeTurnCleanup = trackCodexConversationActiveTurn({
      identity,
      client,
      threadId,
      turnId: activeTurnId,
    });
    turnCollector.setTurnId(activeTurnId);
    await turnRoute.bindTurn(activeTurnId);
    const completion = await turnCollector.wait({
      timeoutMs: params.timeoutMs ?? DEFAULT_BOUND_TURN_TIMEOUT_MS,
    });
    const replyText = completion.replyText.trim();
    turnSucceeded = true;
    return {
      reply: {
        text: replyText || "Codex completed without a text reply.",
      },
    };
  } catch (error) {
    if (isCodexAppServerOverloadError(error) && error.method === "thread/resume") {
      throw error;
    }
    if (error instanceof CodexThreadDirectInputError) {
      if (params.incognito && ownsNativeSubscription) {
        // Resume can reveal a cold child's capability only after subscribing.
        // Release that subscription without clearing the preserved binding.
        const released = await unsubscribeCodexThreadBestEffort(client, {
          threadId,
          timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
        });
        if (!released) {
          await retireUnsafeCodexTurnClientBestEffort(client, "parent-owned thread unsubscribe");
        }
      }
      throw error;
    }
    if (
      (error instanceof CodexConversationTurnTimeoutError && activeTurnId) ||
      (turnRoute && isCodexAppServerIndeterminateRequestCancellationError(error))
    ) {
      // Per-thread serialization makes an empty startup interrupt follow an
      // accepted turn whose id was lost to local request cancellation.
      const completed = await interruptCodexTurnAndWaitBestEffort(client, {
        threadId,
        turnId: activeTurnId ?? "",
      });
      if (!completed) {
        // Retirement detaches the physical client while sibling leases finish;
        // never send another cleanup request or retire that detached client twice.
        await retireUnsafeCodexTurnClientBestEffort(client, "turn interrupt");
        isolatedSubscriptionClient = client;
      }
    }
    if (params.incognito) {
      const bindingReleased = await params.bindingStore.mutate(identity, {
        kind: "clear",
        threadId,
      });
      if (bindingReleased && isolatedSubscriptionClient !== client) {
        const unsubscribed = await unsubscribeCodexThreadBestEffort(client, {
          threadId,
          timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
        });
        if (!unsubscribed) {
          await retireUnsafeCodexTurnClientBestEffort(client, "thread unsubscribe");
        }
      }
    }
    throw error;
  } finally {
    activeTurnCleanup();
    turnRoute?.release();
    try {
      if (
        ownsNativeSubscription &&
        isolatedSubscriptionClient !== client &&
        !params.incognito &&
        isCodexAppServerClientRuntimeLive(client)
      ) {
        // Ownership callbacks are branded to one physical client and native
        // thread; an old generation must never clean up its replacement.
        const currentLiveThreadOwnership =
          liveThreadOwnership?.client === client && liveThreadOwnership.threadId === threadId
            ? liveThreadOwnership.ownership
            : undefined;
        let retained = false;
        if (turnSucceeded) {
          retained = await params.bindingStore.withLease(identity, async () => {
            const current = await params.bindingStore.read(identity);
            if (current?.threadId !== threadId || current.clientId !== client.getInstanceId()) {
              return false;
            }
            // Claim before turn/start and republish only its unchanged owner;
            // TTL/LRU eviction must never detach an active conversation turn.
            return await retainCodexAppServerBindingSubscription(
              client,
              threadId,
              currentLiveThreadOwnership,
            );
          });
        }
        if (!retained) {
          const released = currentLiveThreadOwnership
            ? await currentLiveThreadOwnership.release(threadId).then(() => true)
            : await unsubscribeCodexThreadBestEffort(client, {
                threadId,
                timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
              });
          if (!released) {
            await closeCodexStartupClientBestEffort(client);
          }
        }
      }
    } catch (error) {
      embeddedAgentLog.warn("codex conversation subscription cleanup failed", {
        threadId,
        reason: formatErrorMessage(error),
      });
      await closeCodexStartupClientBestEffort(client);
    } finally {
      releaseCodexAppServerClientLease(clientLease);
    }
  }
}

function assertNativeConversationApprovalPolicySupported(
  runtime: Pick<
    ReturnType<typeof resolveCodexAppServerRuntimeOptions>,
    "approvalPolicy" | "approvalsReviewer"
  >,
): void {
  if (runtime.approvalPolicy !== "never" && runtime.approvalsReviewer === "user") {
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
  incognito: boolean;
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
    incognito: boolean;
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
      serviceTier: inherited?.serviceTier,
      config: params.config,
      sessionKey: params.data.legacyBinding ? params.sessionKey : params.data.source?.sessionKey,
      source: params.data.source,
      incognito: params.incognito,
      agentId: params.data.source?.agentId ?? params.data.agentId,
    };
    // Harness threads retain immutable tools, developer instructions, and app
    // policy. Transfer bounded visible history into a fresh bound-only thread.
    const threadId = requested?.threadId;
    if (threadId && !options.forceNew) {
      await attachExistingThread({ ...bindingParams, threadId });
    } else {
      await bindThread(bindingParams);
    }
    const stored = await params.bindingStore.read(identity);
    if (!stored) {
      throw new Error("Codex conversation binding disappeared while initializing its thread.");
    }
    if (sourceIdentity && params.data.source && !current?.conversationSourceTransferComplete) {
      await params.bindingStore.withLease(sourceIdentity, async () => {
        const source = await params.bindingStore.read(sourceIdentity);
        if (source && source.threadId === params.data.source?.threadId) {
          const sourceSessionKey =
            sourceIdentity.sessionKey ??
            resolveTranscriptSessionKeyBySessionId({
              agentId: sourceIdentity.agentId,
              sessionId: sourceIdentity.sessionId,
              storePath: resolveStorePath(params.config?.session?.store, {
                agentId: sourceIdentity.agentId,
              }),
            });
          if (
            sourceSessionKey &&
            resolveActiveEmbeddedRunSessionId(sourceSessionKey) === sourceIdentity.sessionId
          ) {
            throw new Error(
              "Codex source session has an active run; stop it before binding this conversation.",
            );
          }
          if (source.threadId !== stored.threadId) {
            await releaseCodexAppServerBindingSubscription(source);
            await projectConversationSourceHistory(params.data.source, stored, params.config);
          }
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

async function projectConversationSourceHistory(
  source: { agentId: string; sessionId: string; sessionKey?: string; threadId: string },
  target: { threadId: string; clientId?: string },
  config?: CodexConversationConfig,
): Promise<void> {
  const storePath = resolveStorePath(config?.session?.store, { agentId: source.agentId });
  const sessionKey =
    source.sessionKey ??
    resolveTranscriptSessionKeyBySessionId({
      agentId: source.agentId,
      sessionId: source.sessionId,
      storePath,
    });
  if (!sessionKey) {
    return;
  }
  // Local visible transcripts remain readable for ephemeral and paginated
  // Codex threads, both of which reject native includeTurns history reads.
  const entries = await readVisibleSessionTranscriptMessageEntries({
    agentId: source.agentId,
    sessionId: source.sessionId,
    sessionKey,
    storePath,
  });
  const history = projectBoundedCodexVisibleSessionHistory(entries);
  if (history.length === 0) {
    return;
  }
  const clientLease = retainSharedCodexAppServerClientByInstanceId(target.clientId);
  if (!clientLease) {
    throw new Error("Codex conversation source history lost its bound client owner.");
  }
  try {
    await clientLease.client.request("thread/inject_items", {
      threadId: target.threadId,
      items: history,
    });
  } finally {
    clientLease.release();
  }
}

function isCodexThreadNotFoundError(error: unknown): boolean {
  if (isCodexAppServerOverloadError(error) || isCodexAppServerUnsafeSubscriptionError(error)) {
    return false;
  }
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
): Extract<CodexAppServerBindingIdentity, { kind: "conversation" }> {
  return { kind: "conversation", bindingId: data.bindingId };
}

export const codexConversationBindingRuntime = {
  startThread: startCodexConversationThread,
  handleInboundClaim: handleCodexConversationInboundClaim,
  handleBindingResolved: handleCodexConversationBindingResolved,
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
