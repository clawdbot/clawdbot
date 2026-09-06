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
const conversationTargets = [
  { kind: "direct", root: `dm:${conversationId}`, thread: `thread:/v1/dm/${conversationId}` },
  { kind: "group", root: `group:${conversationId}`, thread: `thread:/v1/group/${conversationId}` },
  { kind: "channel", root: `channel:${conversationId}`, thread: `thread:${conversationId}` },
] as const;

async function withQaMessageTool(
  source: {
    kind: QaBusConversationKind;
    threadId?: string;
    trusted?: boolean;
    sourceReplyOnly?: boolean;
    accountId?: string;
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
        channels: {
          "qa-channel": { baseUrl: bus.baseUrl, accounts: { secondary: {} } },
        },
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
          accountId: source.accountId ?? "default",
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
              AccountId: inbound.accountId,
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
          account: qaChannelPlugin.config.resolveAccount(config, inbound.accountId),
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

  it.each(
    conversationTargets.flatMap(({ kind, root, thread }) =>
      [undefined, "topic"].flatMap((threadId) =>
        ["default", "secondary"].map((accountId) => ({
          kind,
          root,
          thread,
          threadId,
          accountId,
          name: `${kind}/${threadId ?? "root"}/${accountId}`,
        })),
      ),
    ),
  )("scopes read/react/edit to the exact $name source", async (source) => {
    await withQaMessageTool(
      { ...source, trusted: true },
      async ({ tool, inbound, busState, baseUrl }) => {
        const { kind, root, thread, threadId, accountId } = source;
        const foreignRoots = conversationTargets
          .filter((target) => target.kind !== kind)
          .map((target) => target.root);
        const own = busState.addOutboundMessage({
          to: root,
          accountId,
          threadId,
          text: "original",
        });
        const foreignMessages = [
          ...foreignRoots.map((to) => ({ name: "kind", to, threadId, accountId })),
          { name: "root", to: `${root}-other`, threadId, accountId },
          { name: "thread", to: root, threadId: "other", accountId },
          ...(threadId ? [{ name: "unthreaded", to: root, accountId }] : []),
          {
            name: "account",
            to: root,
            threadId,
            accountId: accountId === "default" ? "secondary" : "default",
          },
        ].map(({ name, ...params }) => ({
          name,
          message: busState.addOutboundMessage({ ...params, text: `foreign ${name}` }),
        }));
        const inboundRead = await tool.execute("read-inbound", {
          action: "read",
          messageId: inbound.id,
        });
        expect(inboundRead.details).toMatchObject({ message: inbound });
        for (const args of [
          { action: "read" },
          { action: "react", emoji: "white_check_mark" },
          { action: "edit", message: "edited" },
        ]) {
          for (const { name, message } of foreignMessages) {
            await expect(
              tool.execute(`foreign-${name}-${args.action}`, { ...args, messageId: message.id }),
            ).rejects.toThrow(
              name === "account" ? "message not found" : "not in the selected conversation",
            );
          }
          for (const target of [...foreignRoots, `${root}-other`, `${thread}/other`]) {
            await expect(
              tool.execute(`foreign-target-${args.action}`, { ...args, target, messageId: own.id }),
            ).rejects.toThrow("requires the exact current conversation and account");
          }
          await expect(
            tool.execute(`foreign-thread-${args.action}`, {
              ...args,
              messageId: own.id,
              threadId: "other",
            }),
          ).rejects.toThrow("not in the selected conversation");
          await expect(
            tool.execute(`foreign-account-${args.action}`, {
              ...args,
              messageId: own.id,
              accountId: accountId === "default" ? "secondary" : "default",
            }),
          ).rejects.toThrow("trusted current account");
          for (const target of [
            {},
            { target: root },
            { to: root },
            { channelId: root },
            ...(threadId ? [{ target: `${thread}/${threadId}` }, { threadId }] : []),
          ]) {
            const result = await tool.execute(`own-${args.action}`, {
              ...args,
              ...target,
              messageId: own.id,
            });
            expect(result.details).toMatchObject({
              message: { id: own.id, conversation: inbound.conversation, accountId },
            });
            if (threadId) {
              expect(result.details).toHaveProperty("message.threadId", threadId);
            } else {
              expect(result.details).not.toHaveProperty("message.threadId");
            }
          }
        }
        const snapshot = await getQaBusState(baseUrl);
        expect(snapshot.messages).toHaveLength(foreignMessages.length + 2);
        const edited = snapshot.messages.find((message) => message.id === own.id);
        expect(edited).toMatchObject({
          accountId,
          conversation: inbound.conversation,
          text: "edited",
          reactions: [expect.objectContaining({ emoji: "white_check_mark", senderId: "openclaw" })],
        });
        expect(edited?.threadId).toBe(threadId);
        expect(snapshot.messages.find((message) => message.id === inbound.id)).toEqual(inbound);
        for (const { message: foreign } of foreignMessages) {
          expect(snapshot.messages.find((message) => message.id === foreign.id)).toEqual(foreign);
        }
      },
    );
  });

  it.each(conversationTargets)(
    "preserves thread and reply intent through $kind ingress",
    async ({ kind, root, thread }) => {
      await withQaMessageTool({ kind, threadId: "topic" }, async ({ tool, inbound, baseUrl }) => {
        const cases: Array<{
          name: string;
          args: Record<string, unknown>;
          threadId?: string;
          replyToId?: string;
          conversation?: QaBusMessage["conversation"];
        }> = [
          { name: "implicit", args: {}, threadId: "topic", replyToId: inbound.id },
          { name: "same root", args: { target: root }, threadId: "topic", replyToId: inbound.id },
          { name: "to alias", args: { to: root }, threadId: "topic", replyToId: inbound.id },
          {
            name: "bare explicit channel target",
            args: { target: conversationId },
            conversation: { kind: "channel", id: conversationId },
            threadId: kind === "channel" ? "topic" : undefined,
            replyToId: kind === "channel" ? inbound.id : undefined,
          },
          {
            name: "same thread target",
            args: { target: `${thread}/topic` },
            threadId: "topic",
            replyToId: inbound.id,
          },
          { name: "other thread target", args: { target: `${thread}/other` }, threadId: "other" },
          {
            name: "explicit thread",
            args: { threadId: "other" },
            threadId: "other",
            replyToId: inbound.id,
          },
          {
            name: "explicit reply",
            args: { replyTo: "chosen-message" },
            threadId: "topic",
            replyToId: "chosen-message",
          },
          {
            name: "other conversation",
            args: { target: `${root}-other` },
            conversation: { kind, id: `${conversationId}-other` },
          },
          {
            name: "same ID foreign kind",
            args: { target: `${kind === "direct" ? "group" : "dm"}:${conversationId}` },
            conversation: { kind: kind === "direct" ? "group" : "direct", id: conversationId },
          },
          ...[{ topLevel: true }, { threadId: null }].flatMap((optOut) => [
            { name: `implicit ${JSON.stringify(optOut)}`, args: optOut },
            { name: `root ${JSON.stringify(optOut)}`, args: { target: root, ...optOut } },
            {
              name: `thread target ${JSON.stringify(optOut)}`,
              args: { target: `${thread}/other`, ...optOut },
              threadId: "other",
            },
            {
              name: `explicit reply ${JSON.stringify(optOut)}`,
              args: { ...optOut, replyTo: "chosen-message" },
              replyToId: "chosen-message",
            },
          ]),
          { name: "both opt-outs", args: { topLevel: true, threadId: null } },
          {
            name: "explicit thread with topLevel",
            args: { threadId: "other", topLevel: true },
            threadId: "other",
          },
          {
            name: "explicit thread and reply with topLevel",
            args: { threadId: "other", replyTo: "chosen-message", topLevel: true },
            threadId: "other",
            replyToId: "chosen-message",
          },
        ];
        for (const testCase of cases) {
          await tool.execute(testCase.name, {
            action: "send",
            message: testCase.name,
            ...testCase.args,
          });
        }
        await expect(
          tool.execute("conflicting-thread", {
            action: "send",
            target: `${thread}/topic`,
            threadId: "other",
            message: nonce,
          }),
        ).rejects.toThrow("conflicts with the explicit threadId");
        const snapshot = await getQaBusState(baseUrl);
        const outbound = snapshot.messages.filter((message) => message.direction === "outbound");
        expect(outbound).toHaveLength(cases.length);
        for (const [index, testCase] of cases.entries()) {
          expect.soft(outbound[index], testCase.name).toMatchObject({
            conversation: testCase.conversation ?? inbound.conversation,
            accountId: inbound.accountId,
            text: testCase.name,
            attachments: [],
          });
          expect.soft(outbound[index]?.threadId, testCase.name).toBe(testCase.threadId);
          expect.soft(outbound[index]?.replyToId, testCase.name).toBe(testCase.replyToId);
        }
      });
    },
  );

  it.each([
    { name: "source-only", sourceReplyOnly: true, trusted: false },
    { name: "trusted turn", sourceReplyOnly: false, trusted: true },
    { name: "trusted source-only", sourceReplyOnly: true, trusted: true },
  ])("inherits within $name authority and rejects account escapes", async (scope) => {
    await withQaMessageTool(
      { ...scope, kind: "direct", threadId: "topic", accountId: "secondary" },
      async ({ tool, inbound, baseUrl }) => {
        await expect(
          tool.execute("other-account", { action: "send", accountId: "default", message: nonce }),
        ).rejects.toThrow(
          scope.sourceReplyOnly ? "another channel account" : "trusted current account",
        );
        if (scope.sourceReplyOnly) {
          for (const args of [
            { target: `dm:${conversationId}-other` },
            { target: `group:${conversationId}` },
            { target: `thread:/v1/dm/${conversationId}/other` },
            { threadId: "other" },
            { replyTo: "foreign-message" },
            { topLevel: true },
          ]) {
            await expect(
              tool.execute("outside-source", { action: "send", message: nonce, ...args }),
            ).rejects.toThrow("Completion source replies");
          }
        }
        for (const args of [
          {},
          { target: `dm:${conversationId}`, accountId: "SECONDARY", replyTo: inbound.id },
        ]) {
          await tool.execute("within-source", { action: "send", message: nonce, ...args });
        }
        const snapshot = await getQaBusState(baseUrl);
        const outbound = snapshot.messages.filter((message) => message.direction === "outbound");
        expect(outbound).toHaveLength(2);
        for (const message of outbound) {
          expect(message).toMatchObject({
            conversation: inbound.conversation,
            accountId: "secondary",
            text: nonce,
          });
          expect.soft(message.threadId).toBe("topic");
          expect(message.replyToId).toBe(inbound.id);
        }
      },
    );
  });
});
