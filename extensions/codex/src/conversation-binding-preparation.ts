/** Canonical conversation thread preparation, policy, and binding ownership. */
import {
  resolveActiveEmbeddedRunSessionId,
  resolveSandboxContext,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { resolveSessionAgentIdsStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import { loadExecApprovals } from "openclaw/plugin-sdk/exec-approvals-runtime";
import {
  getSessionEntry,
  resolveStorePath,
  resolveTranscriptSessionKeyBySessionId,
} from "openclaw/plugin-sdk/session-store-runtime";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import { resolveCodexAppServerForModelProvider } from "./app-server/app-server-policy.js";
import { closeCodexStartupClientBestEffort } from "./app-server/attempt-client-cleanup.js";
import {
  isCodexAppServerNativeAuthProfile,
  normalizeCodexAppServerBindingModelProvider,
  type resolveCodexAppServerAuthProfileIdForAgent,
  type CodexAppServerAuthProfileLookup,
} from "./app-server/auth-profile.js";
import {
  hasCodexAppServerLiveThread,
  isCodexAppServerClientRuntimeLive,
  isCodexAppServerLiveThreadClaimed,
  releaseCodexAppServerLiveThread,
} from "./app-server/client-runtime.js";
import type { CodexAppServerClient } from "./app-server/client.js";
import {
  canUseCodexModelBackedApprovalsReviewerForModel,
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
import { assertCodexThreadAcceptsDirectInput } from "./app-server/protocol-validators.js";
import type {
  CodexServiceTier,
  CodexThreadResumeResponse,
  CodexThreadStartParams,
  CodexThreadStartResponse,
  JsonObject,
} from "./app-server/protocol.js";
import {
  assertCodexBindingMayBeReplaced,
  sessionBindingIdentity,
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
  rollbackCodexAppServerBindingSubscription,
  withExclusiveCodexAppServerThread,
} from "./app-server/thread-ownership.js";
import { resumeCodexAppServerThread } from "./app-server/thread-resume.js";
import { projectBoundedCodexVisibleSessionHistory } from "./app-server/transcript-history-projection.js";
import {
  resolveCodexDefaultWorkspaceDir,
  type CodexAppServerConversationBindingData,
} from "./conversation-binding-data.js";

const NATIVE_CONVERSATION_INTERACTIVE_APPROVALS_UNAVAILABLE =
  "OpenClaw native Codex conversation binding cannot route interactive approvals yet; use the Codex harness or explicit /acp spawn codex for that workflow.";

export type CodexConversationConfig = Parameters<
  typeof resolveCodexAppServerAuthProfileIdForAgent
>[0]["config"];
export async function resolveConversationAppServerRuntime(params: {
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
      ? resolveSessionAgentIdsStrict({ sessionKey: params.sessionKey, config: params.config })
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

export const CODEX_CONVERSATION_THREAD_DEVELOPER_INSTRUCTIONS =
  "This Codex thread is bound to an OpenClaw conversation. Answer normally; OpenClaw will deliver your final response back to the conversation.";

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
  const agentLookup = buildCodexConversationAgentLookup({
    agentDir: params.agentDir,
    config: params.config,
  });
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

export function buildConversationThreadRequest(
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
  const config = buildCodexProjectDocThreadConfig(
    mergeCodexThreadConfigs(networkProxy?.configPatch, buildDisabledAppsConfigPatch()),
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
    const current = params.bindingStore.read(params.identity);
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

async function bindThread(params: CodexThreadBindingParams, threadId?: string): Promise<void> {
  const current = params.bindingStore.read(params.identity);
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

export function assertNativeConversationApprovalPolicySupported(
  runtime: Pick<
    ReturnType<typeof resolveCodexAppServerRuntimeOptions>,
    "approvalPolicy" | "approvalsReviewer"
  >,
): void {
  if (runtime.approvalPolicy !== "never" && runtime.approvalsReviewer === "user") {
    throw new Error(NATIVE_CONVERSATION_INTERACTIVE_APPROVALS_UNAVAILABLE);
  }
}

export async function prepareCodexConversationBinding(
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
  const identity = { kind: "conversation" as const, bindingId: params.data.bindingId };
  const snapshot = params.bindingStore.read(identity);
  const run = () =>
    params.bindingStore.withLease(identity, async () => {
      const current = params.bindingStore.read(identity);
      if (current?.threadId !== snapshot?.threadId || current?.clientId !== snapshot?.clientId) {
        throw new Error("Codex conversation binding changed before preparation.");
      }
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
      const sourceBinding = sourceIdentity ? params.bindingStore.read(sourceIdentity) : undefined;
      assertCodexBindingMayBeReplaced(current, "initializing a conversation-bound Codex thread");
      assertCodexBindingMayBeReplaced(
        sourceBinding,
        "transferring a session into a conversation-bound Codex thread",
      );
      const inherited = current ?? sourceBinding;
      const agentLookup = buildCodexConversationAgentLookup({
        agentDir: params.data.agentDir,
        config: params.config,
      });
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
      await bindThread(bindingParams, options.forceNew ? undefined : threadId);
      const stored = params.bindingStore.read(identity);
      if (!stored) {
        throw new Error("Codex conversation binding disappeared while initializing its thread.");
      }
      if (sourceIdentity && params.data.source && !current?.conversationSourceTransferComplete) {
        await params.bindingStore.withLease(sourceIdentity, async () => {
          const source = params.bindingStore.read(sourceIdentity);
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
  // Attach and ordinary resume acquire the native queue before a durable binding lease.
  const threadId = params.data.start?.threadId ?? snapshot?.threadId;
  if (threadId) {
    await withExclusiveCodexAppServerThread({
      bindingStore: params.bindingStore,
      identity,
      threadId,
      run,
    });
  } else {
    await run();
  }
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

export function resolveModelBackedReviewerPolicyProvider(params: {
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

export function buildCodexConversationAgentLookup(params: {
  agentDir?: string;
  config?: CodexAppServerAuthProfileLookup["config"];
}): Pick<CodexAppServerAuthProfileLookup, "agentDir" | "config"> {
  const agentDir = params.agentDir?.trim();
  return {
    ...(agentDir ? { agentDir } : {}),
    ...(params.config ? { config: params.config } : {}),
  };
}
