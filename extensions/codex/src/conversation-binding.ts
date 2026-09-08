import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { PluginHookInboundClaimEvent } from "openclaw/plugin-sdk/plugin-entry";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { resolveCodexAppServerForModelProvider } from "./app-server/app-server-policy.js";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  closeCodexStartupClientBestEffort,
  interruptCodexTurnAndWaitBestEffort,
  isCodexAppServerUnsafeSubscriptionError,
  retireUnsafeCodexTurnClientBestEffort,
  unsubscribeCodexThreadBestEffort,
} from "./app-server/attempt-client-cleanup.js";
import { normalizeCodexAppServerBindingModelProvider } from "./app-server/auth-profile.js";
import {
  consumeCodexAppServerLiveThread,
  isCodexAppServerClientRuntimeLive,
  type CodexAppServerLiveThreadOwnership,
} from "./app-server/client-runtime.js";
import {
  isCodexAppServerIndeterminateRequestCancellationError,
  isCodexAppServerOverloadError,
  type CodexAppServerClient,
} from "./app-server/client.js";
import { codexSandboxPolicyForTurn } from "./app-server/config.js";
import {
  assertCodexThreadAcceptsDirectInput,
  assertCodexThreadStartResponse,
  CodexThreadDirectInputError,
} from "./app-server/protocol-validators.js";
import type { CodexTurnStartResponse } from "./app-server/protocol.js";
import {
  assertCodexBindingMayBeReplaced,
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
import {
  isSameCodexAppServerThreadOwner,
  releaseCodexAppServerBindingSubscription,
  retainCodexAppServerBindingSubscription,
  withExclusiveCodexAppServerThread,
} from "./app-server/thread-ownership.js";
import { resumeCodexAppServerThread } from "./app-server/thread-resume.js";
import {
  getCodexAppServerTurnRouter,
  type CodexThreadRouteReservation,
} from "./app-server/turn-router.js";
import type { CodexAppServerConversationBindingData } from "./conversation-binding-data.js";
import {
  assertNativeConversationApprovalPolicySupported,
  buildCodexConversationAgentLookup,
  buildConversationThreadRequest,
  CODEX_CONVERSATION_THREAD_DEVELOPER_INSTRUCTIONS,
  prepareCodexConversationBinding,
  resolveConversationAppServerRuntime,
  resolveModelBackedReviewerPolicyProvider,
  type CodexConversationConfig,
} from "./conversation-binding-preparation.js";
import { trackCodexConversationActiveTurn } from "./conversation-control.js";
import {
  CodexConversationTurnTimeoutError,
  createCodexConversationTurnCollector,
} from "./conversation-turn-collector.js";
import { buildCodexConversationTurnInput } from "./conversation-turn-input.js";

const DEFAULT_BOUND_TURN_TIMEOUT_MS = 20 * 60_000;

type BoundTurnResult = {
  reply: ReplyPayload;
};

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
  const agentLookup = buildCodexConversationAgentLookup({
    agentDir: params.data.agentDir,
    config: params.config,
  });
  const identity = { kind: "conversation" as const, bindingId: params.data.bindingId };
  const binding = params.bindingStore.read(identity);
  if (!binding?.threadId) {
    throw new Error("bound Codex conversation has no thread binding");
  }
  return await withExclusiveCodexAppServerThread({
    bindingStore: params.bindingStore,
    identity,
    threadId: binding.threadId,
    run: async () => {
      const current = params.bindingStore.read(identity);
      if (!isSameCodexAppServerThreadOwner(current, binding)) {
        throw new Error("Codex conversation binding changed before its turn.");
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
              await retireUnsafeCodexTurnClientBestEffort(
                client,
                "parent-owned thread unsubscribe",
              );
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
                const latest = params.bindingStore.read(identity);
                if (latest?.threadId !== threadId || latest.clientId !== client.getInstanceId()) {
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
    },
  });
}

export async function runBoundTurnWithMissingThreadRecovery(params: {
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
  await prepareCodexConversationBinding(params);
  try {
    return await runBoundTurn(params);
  } catch (error) {
    if (!isCodexThreadNotFoundError(error)) {
      throw error;
    }
    await prepareCodexConversationBinding(params, { forceNew: true });
    return await runBoundTurn(params);
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
