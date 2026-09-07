import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type {
  PluginConversationBindingResolvedEvent,
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { resolveCodexAppServerAuthProfileIdForAgent } from "./app-server/auth-profile.js";
import { assertCodexBindingMayBeReplaced } from "./app-server/session-binding-record.js";
import type { CodexAppServerBindingStore } from "./app-server/session-binding.js";
import { withCodexConversationThreadActivity } from "./app-server/thread-ownership-queue.js";
import { defineCodexBuildState } from "./build-state.js";
import { canMutateCodexHost, CODEX_NATIVE_EXECUTION_AUTH_ERROR } from "./command-authorization.js";
import { formatCodexDisplayText } from "./command-formatters.js";
import {
  readCodexConversationBindingData,
  readCodexConversationBindingDataRecord,
} from "./conversation-binding-data.js";
import { isIncognitoSessionKey } from "./incognito-session.js";
import type { resumeCodexCliSessionOnNode } from "./node-cli-sessions.js";

type CodexConversationRunOptions = {
  bindingStore: CodexAppServerBindingStore;
  pluginConfig?: unknown;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  timeoutMs?: number;
  resumeCodexCliSessionOnNode?: (
    params: Omit<Parameters<typeof resumeCodexCliSessionOnNode>[0], "runtime">,
  ) => ReturnType<typeof resumeCodexCliSessionOnNode>;
};

const getNodeConversationState = defineCodexBuildState(
  "openclaw.codex.conversationBinding",
  () => ({ queue: new KeyedAsyncQueue() }),
);

export async function handleCodexConversationInboundClaim(
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
  const sessionKey = event.sessionKey ?? ctx.sessionKey;
  if (data.kind === "codex-cli-node-session") {
    try {
      const result = await getNodeConversationState().queue.enqueue(
        `${data.nodeId}:${data.sessionId}`,
        async () => {
          const { resolveCodexNativeSandboxBlock } = await import("./app-server/sandbox-guard.js");
          const blocked = resolveCodexNativeSandboxBlock({
            config: options.config,
            sessionKey,
            surface: "Codex CLI node conversation binding",
          });
          if (blocked) {
            return { reply: { text: blocked } };
          }
          const resume = options.resumeCodexCliSessionOnNode;
          if (!resume) {
            return {
              reply: {
                text: "Codex CLI node binding is unavailable because Gateway node runtime is not attached.",
              },
            };
          }
          const resumed = await resume({
            nodeId: data.nodeId,
            sessionId: data.sessionId,
            prompt,
            cwd: data.cwd,
            timeoutMs: options.timeoutMs,
          });
          return {
            reply: { text: resumed.text.trim() || "Codex completed without a text reply." },
          };
        },
      );
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
    const identity = { kind: "conversation" as const, bindingId: data.bindingId };
    // Capture and reserve before any import yields: retirement must not overtake
    // an already-arrived message, even when the execution module is still cold.
    const expected = options.bindingStore.read(identity);
    const result = await withCodexConversationThreadActivity(data.bindingId, async () => {
      const { resolveCodexNativeExecutionBlock } = await import("./app-server/sandbox-guard.js");
      const nativeExecutionBlock = resolveCodexNativeExecutionBlock({
        config: options.config,
        sessionKey,
        agentId: data.agentId,
        surface: "Codex app-server conversation binding",
      });
      if (nativeExecutionBlock) {
        return { reply: { text: nativeExecutionBlock } };
      }
      const { getSessionBindingService } =
        await import("openclaw/plugin-sdk/conversation-binding-runtime");
      const { runBoundTurnWithMissingThreadRecovery } = await import("./conversation-binding.js");
      const currentPublicBinding = getSessionBindingService().resolveByConversation({
        channel: publicBinding.channel,
        accountId: publicBinding.accountId,
        conversationId: publicBinding.conversationId,
        ...(publicBinding.parentConversationId
          ? { parentConversationId: publicBinding.parentConversationId }
          : {}),
      });
      const current = options.bindingStore.read(identity);
      if (
        currentPublicBinding?.bindingId !== publicBinding.bindingId ||
        (expected &&
          (!current ||
            current.threadId !== expected.threadId ||
            current.conversationStartId !== expected.conversationStartId)) ||
        (!expected && current && data.start?.id && current.conversationStartId !== data.start.id)
      ) {
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
        // Source ownership, not the destination channel, controls ephemeral execution.
        incognito: isIncognitoSessionKey(
          data.source?.sessionKey ?? (data.legacyBinding ? sessionKey : undefined),
        ),
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

export async function handleCodexConversationBindingResolved(
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
  const identity = { kind: "conversation" as const, bindingId: data.bindingId };
  const binding = options.bindingStore.read(identity);
  assertCodexBindingMayBeReplaced(binding, "clearing a denied conversation binding");
  if (binding && (!data.start?.id || binding.conversationStartId === data.start.id)) {
    await withCodexConversationThreadActivity(identity.bindingId, async () => {
      const { retireCodexConversationThreadBinding } =
        await import("./app-server/thread-ownership.js");
      return retireCodexConversationThreadBinding({
        bindingStore: options.bindingStore,
        identity,
        expectedThreadId: binding.threadId,
        ...(data.start?.id ? { expectedStartId: data.start.id } : {}),
        ...(isIncognitoSessionKey(data.source?.sessionKey) ? { allowUntracked: true } : {}),
      });
    });
  }
}
