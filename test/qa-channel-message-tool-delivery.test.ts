import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getQaBusState,
  injectQaBusInboundMessage,
  qaChannelPlugin,
  type QaBusConversationKind,
  type QaBusMessage,
} from "../extensions/qa-channel/api.js";
import { createQaBusState, startQaBusServer } from "../extensions/qa-lab/api.js";
import { createMessageTool } from "../src/agents/tools/message-tool-execution.js";
import { buildThreadingToolContext } from "../src/auto-reply/reply/agent-runner-utils.js";
import { resolveReplyToMode } from "../src/auto-reply/reply/reply-threading.js";
import * as bootstrapRegistry from "../src/channels/plugins/bootstrap-registry.js";
import type { OpenClawConfig } from "../src/config/config.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../src/gateway/message-action-turn-capability.js";
import { runMessageAction } from "../src/infra/outbound/message-action-runner.js";
import { createStartAccountContext } from "../src/plugin-sdk/test-helpers/start-account-context.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { createRuntimeChannel } from "../src/plugins/runtime/runtime-channel.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

afterEach(() => {
  vi.restoreAllMocks();
  setActivePluginRegistry(createTestRegistry([]));
});

const conversationId = "qa-shared-id";
const nonce = "implicit-target-nonce";

async function withQaMessageTool(
  source: {
    kind: QaBusConversationKind;
    threadId?: string;
    trusted?: boolean;
    sourceReplyOnly?: boolean;
  },
  exercise: (fixture: {
    tool: ReturnType<typeof createMessageTool>;
    inbound: QaBusMessage;
    busState: ReturnType<typeof createQaBusState>;
    baseUrl: string;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ prefix: "message-tool-qa-target-" }, async (state) => {
    const busState = createQaBusState();
    const bus = await startQaBusServer({ state: busState });
    const controller = new AbortController();
    let capability: string | undefined;
    // Reuse the real plugin's metadata instead of source-JIT loading another
    // copy; bootstrap loading is not part of this delivery boundary.
    vi.spyOn(bootstrapRegistry, "getBootstrapChannelPlugin").mockImplementation((id) => {
      expect(id).toBe("qa-channel");
      return qaChannelPlugin;
    });
    try {
      const config = {
        agents: { entries: { main: { default: true, workspace: state.workspaceDir } } },
        session: { dmScope: "per-channel-peer" },
        channels: { "qa-channel": { baseUrl: bus.baseUrl } },
      } satisfies OpenClawConfig;
      // External-plugin canonicalization would hide a kind lost by the QA
      // producer. Match the bundled runtime's authorization path.
      setActivePluginRegistry(
        createTestRegistry([
          { pluginId: "qa-channel", source: "test", origin: "bundled", plugin: qaChannelPlugin },
        ]),
      );
      const { message: inbound } = await injectQaBusInboundMessage({
        baseUrl: bus.baseUrl,
        input: {
          accountId: "default",
          conversation: { kind: source.kind, id: conversationId },
          senderId: "qa-peer",
          senderName: "QA Peer",
          text: "Reply in this conversation.",
          threadId: source.threadId,
        },
      });
      let dispatched = 0;
      let dispatchError: Error | undefined;
      const channelRuntime = createRuntimeChannel({
        // Replace only the model dispatcher; ingress, session recording, tool
        // normalization, authorization, QA parsing, and HTTP bus delivery stay real.
        dispatchReplyFromConfig: async ({ ctx }) => {
          try {
            dispatched++;
            expect(ctx).toMatchObject({
              Provider: "qa-channel",
              NativeChannelId: conversationId,
              ChatType: source.kind === "direct" ? "direct" : "group",
              AccountId: "default",
              MessageSid: inbound.id,
            });
            const toolContext = buildThreadingToolContext({
              sessionCtx: {
                ...ctx,
                ReplyToMode: resolveReplyToMode(config, "qa-channel", ctx.AccountId, ctx.ChatType),
              },
              config,
              hasRepliedRef: { value: false },
            });
            if (source.trusted) {
              capability = mintMessageActionTurnCapability({
                agentId: "main",
                runId: "qa-resource-run",
                sessionKey: ctx.SessionKey!,
                requesterAccountId: ctx.AccountId,
                requesterSenderId: ctx.SenderId,
                toolContext,
              });
            }
            const tool = createMessageTool({
              config,
              agentId: "main",
              agentSessionKey: ctx.SessionKey,
              agentAccountId: ctx.AccountId,
              ...toolContext,
              messageActionTurnCapability: capability,
              runId: source.trusted ? "qa-resource-run" : undefined,
              sourceReplyOnly: source.sourceReplyOnly,
              sourceReplyDeliveryMode: "message_tool_only",
              workspaceDir: state.workspaceDir,
              runMessageAction,
              getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
              resolveCommandSecretRefsViaGateway: async ({ config: inputConfig }) => ({
                resolvedConfig: inputConfig,
                diagnostics: [],
                targetStatesByPath: {},
                hadUnresolvedTargets: false,
              }),
            });
            await exercise({ tool, inbound, busState, baseUrl: bus.baseUrl });
          } catch (error) {
            dispatchError = toErrorObject(error, "QA message-tool dispatch failed");
          } finally {
            controller.abort();
          }
          return {
            queuedFinal: false,
            counts: { tool: 0, block: 0, final: 0 },
            observedReplyDelivery: true,
          };
        },
      });
      const startAccount = qaChannelPlugin.gateway?.startAccount;
      expect(startAccount).toBeDefined();
      await startAccount!({
        ...createStartAccountContext({
          cfg: config,
          account: qaChannelPlugin.config.resolveAccount(config, "default"),
          abortSignal: controller.signal,
        }),
        channelRuntime,
      });
      expect(dispatched).toBe(1);
      if (dispatchError) {
        throw dispatchError;
      }
    } finally {
      if (capability) {
        revokeMessageActionTurnCapability(capability);
      }
      controller.abort();
      await bus.stop();
    }
  });
}

describe("QA message-tool current conversation delivery", () => {
  it.each([
    { name: "implicit direct", kind: "direct", explicit: false },
    { name: "implicit group", kind: "group", explicit: false },
    { name: "implicit channel", kind: "channel", explicit: false },
    { name: "explicit canonical DM", kind: "direct", explicit: true },
    { name: "source-only direct", kind: "direct", explicit: false, sourceReplyOnly: true },
  ] as const)("preserves the inbound conversation for $name", async (testCase) => {
    await withQaMessageTool(testCase, async ({ tool, inbound, baseUrl }) => {
      if ("sourceReplyOnly" in testCase) {
        await expect(
          tool.execute("foreign-kind", {
            action: "send",
            target: `channel:${conversationId}`,
            message: nonce,
          }),
        ).rejects.toThrow("cannot target another conversation or thread");
      }
      await tool.execute("qa-send", {
        action: "send",
        message: nonce,
        final: true,
        ...(testCase.explicit ? { target: `dm:${conversationId}` } : {}),
      });
      const snapshot = await getQaBusState(baseUrl);
      const outbound = snapshot.messages.filter((message) => message.direction === "outbound");
      expect(outbound).toEqual([
        expect.objectContaining({
          conversation: inbound.conversation,
          accountId: inbound.accountId,
          text: nonce,
          replyToId: inbound.id,
          attachments: [],
        }),
      ]);
      expect(outbound[0]?.threadId).toBeUndefined();
      expect(snapshot.threads).toEqual([]);
    });
  });

  it.each(["direct", "group"] as const)(
    "scopes targetless read/react/edit to the %s source, rejecting same-ID foreign kinds",
    async (kind) => {
      await withQaMessageTool({ kind, trusted: true }, async ({ tool, busState, baseUrl }) => {
        const own = busState.addOutboundMessage({
          to: `${kind === "direct" ? "dm" : kind}:${conversationId}`,
          text: "original",
        });
        const foreign = busState.addOutboundMessage({
          to: `channel:${conversationId}`,
          text: "foreign",
        });
        for (const args of [
          { action: "read" },
          { action: "react", emoji: "white_check_mark" },
          { action: "edit", message: "edited" },
        ]) {
          await expect(
            tool.execute(`foreign-${args.action}`, { ...args, messageId: foreign.id }),
          ).rejects.toThrow("not in the selected conversation");
          const result = await tool.execute(`own-${args.action}`, { ...args, messageId: own.id });
          expect(result.details).toMatchObject({
            message: { id: own.id, conversation: own.conversation },
          });
        }
        const snapshot = await getQaBusState(baseUrl);
        expect(snapshot.messages.find((message) => message.id === own.id)).toMatchObject({
          text: "edited",
          reactions: [expect.objectContaining({ emoji: "white_check_mark", senderId: "openclaw" })],
        });
        expect(snapshot.messages.find((message) => message.id === foreign.id)).toEqual(foreign);
      });
    },
  );

  it.each([
    { name: "topLevel", args: { topLevel: true }, threadId: undefined, reply: false },
    { name: "null threadId", args: { threadId: null }, threadId: undefined, reply: false },
    {
      name: "explicit thread target",
      args: { target: `thread:${conversationId}/topic` },
      threadId: "topic",
      reply: true,
    },
  ])("keeps thread targeting separate for $name", async (testCase) => {
    await withQaMessageTool(
      { kind: "channel", threadId: "topic" },
      async ({ tool, inbound, baseUrl }) => {
        await tool.execute("qa-thread-send", {
          action: "send",
          message: nonce,
          final: true,
          ...testCase.args,
        });
        const snapshot = await getQaBusState(baseUrl);
        const outbound = snapshot.messages.filter((message) => message.direction === "outbound");
        expect(outbound).toEqual([
          expect.objectContaining({
            conversation: inbound.conversation,
            accountId: inbound.accountId,
            text: nonce,
            attachments: [],
          }),
        ]);
        expect(outbound[0]?.threadId).toBe(testCase.threadId);
        expect(outbound[0]?.replyToId).toBe(testCase.reply ? inbound.id : undefined);
      },
    );
  });
});
