import path from "node:path";
import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-message";
import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { extractToolPayload } from "openclaw/plugin-sdk/tool-payload";
import { afterEach, describe, expect, it } from "vitest";
import { createQaBusState, startQaBusServer } from "../../qa-lab/bus-api.js";
import { qaChannelPlugin, setQaChannelRuntime } from "../api.js";

type QaRunPreparedTurn = Parameters<PluginRuntime["channel"]["turn"]["runPrepared"]>[0];

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

function installQaChannelTestRegistry() {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "qa-channel", plugin: qaChannelPlugin, source: "test" }]),
  );
}

function expectDispatchedContext(ctx: Record<string, unknown> | null): Record<string, unknown> {
  expect(ctx).not.toBeNull();
  if (ctx === null) {
    throw new Error("Expected dispatched context");
  }
  return ctx;
}

function createMockQaRuntime(params?: {
  onDispatch?: (ctx: Record<string, unknown>) => void;
}): PluginRuntime {
  const sessionUpdatedAt = new Map<string, number>();
  return createPluginRuntimeMock({
    channel: {
      mentions: {
        buildMentionRegexes() {
          return [/^@openclaw\b/i];
        },
        matchesMentionPatterns(text: string, patterns: RegExp[]) {
          return patterns.some((pattern) => pattern.test(text));
        },
      },
      routing: {
        resolveAgentRoute({
          accountId,
          peer,
        }: {
          accountId?: string | null;
          peer?: { kind?: string; id?: string } | null;
        }) {
          return {
            agentId: "qa-agent",
            channel: "qa-channel",
            accountId: accountId ?? "default",
            sessionKey: `qa-agent:${peer?.kind ?? "direct"}:${peer?.id ?? "default"}`,
            mainSessionKey: "qa-agent:main",
            lastRoutePolicy: "session",
            matchedBy: "default",
          };
        },
      },
      session: {
        resolveStorePath(_store: string | undefined, { agentId }: { agentId: string }) {
          return agentId;
        },
        readSessionUpdatedAt({ sessionKey }: { sessionKey: string }) {
          return sessionUpdatedAt.get(sessionKey);
        },
        recordInboundSession({ sessionKey }: { sessionKey: string }) {
          sessionUpdatedAt.set(sessionKey, Date.now());
        },
      },
      reply: {
        resolveEnvelopeFormatOptions() {
          return {};
        },
        formatAgentEnvelope({ body }: { body: string }) {
          return body;
        },
        finalizeInboundContext(ctx: Record<string, unknown>) {
          return ctx as typeof ctx & { CommandAuthorized: boolean };
        },
        async dispatchReplyWithBufferedBlockDispatcher({
          ctx,
          dispatcherOptions,
        }: {
          ctx: { BodyForAgent?: string; Body?: string };
          dispatcherOptions: { deliver: (payload: { text: string }) => Promise<void> };
        }) {
          params?.onDispatch?.(ctx as Record<string, unknown>);
          await dispatcherOptions.deliver({
            text: `qa-echo: ${ctx.BodyForAgent ?? ctx.Body ?? ""}`,
          });
        },
      },
      turn: {
        async runPrepared(turn: QaRunPreparedTurn) {
          await turn.recordInboundSession({
            storePath: turn.storePath,
            sessionKey:
              typeof turn.ctxPayload.SessionKey === "string"
                ? turn.ctxPayload.SessionKey
                : turn.routeSessionKey,
            ctx: turn.ctxPayload,
            onRecordError: turn.record?.onRecordError ?? (() => undefined),
          });
          return {
            admission: turn.admission ?? { kind: "dispatch" as const },
            dispatched: true,
            ctxPayload: turn.ctxPayload,
            routeSessionKey: turn.routeSessionKey,
            dispatchResult: await turn.runDispatch(),
          };
        },
      },
    },
  } as unknown as PluginRuntime);
}

function createQaChannelConfig(params: { baseUrl: string; allowFrom?: string[] }) {
  return {
    channels: {
      "qa-channel": {
        baseUrl: params.baseUrl,
        botUserId: "openclaw",
        botDisplayName: "OpenClaw QA",
        allowFrom: params.allowFrom,
      },
    },
  };
}

function requireQaStartAccount() {
  const startAccount = qaChannelPlugin.gateway?.startAccount;
  if (!startAccount) {
    throw new Error("expected qa-channel gateway startAccount");
  }
  return startAccount;
}

function requireQaMessageAdapter() {
  const adapter = qaChannelPlugin.message;
  if (!adapter) {
    throw new Error("expected qa-channel message adapter");
  }
  return adapter;
}

function requireQaActionHandler() {
  const handleAction = qaChannelPlugin.actions?.handleAction;
  if (!handleAction) {
    throw new Error("expected qa-channel action handler");
  }
  return handleAction;
}

async function startQaChannelTestHarness(params?: {
  runtime?: PluginRuntime;
  allowFrom?: string[];
}) {
  installQaChannelTestRegistry();
  const state = createQaBusState();
  const bus = await startQaBusServer({ state });
  setQaChannelRuntime(params?.runtime ?? createMockQaRuntime());
  const cfg = createQaChannelConfig({ baseUrl: bus.baseUrl, allowFrom: params?.allowFrom });
  const account = qaChannelPlugin.config.resolveAccount(cfg, "default");
  const abort = new AbortController();
  const startAccount = requireQaStartAccount();
  const task = startAccount(
    createStartAccountContext({
      account,
      cfg,
      abortSignal: abort.signal,
    }),
  );
  return {
    state,
    baseUrl: bus.baseUrl,
    async stop() {
      abort.abort();
      await task;
      await bus.stop();
    },
  };
}

describe("qa-channel plugin", () => {
  it("derives thread-aware outbound session routes from explicit thread targets", async () => {
    const route = await qaChannelPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "thread:qa-room/thread-1",
    });

    expect(route?.sessionKey).toBe("agent:main:qa-channel:channel:thread:qa-room/thread-1");
    expect(route?.baseSessionKey).toBe("agent:main:qa-channel:channel:thread:qa-room/thread-1");
    expect(route?.threadId).toBeUndefined();
  });

  it("derives group outbound session routes from explicit group targets", async () => {
    const route = await qaChannelPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "group:qa-room",
    });

    expect(route?.sessionKey).toBe("agent:main:qa-channel:group:group:qa-room");
    expect(route?.baseSessionKey).toBe("agent:main:qa-channel:group:group:qa-room");
    expect(route?.chatType).toBe("group");
    expect(route?.to).toBe("group:qa-room");
  });

  it("normalizes explicit group targets for session group policy lookup", () => {
    const resolved = qaChannelPlugin.messaging?.resolveSessionConversation?.({
      kind: "group",
      rawId: "group:qa-room",
    });

    expect(resolved?.id).toBe("qa-room");
    expect(resolved?.baseConversationId).toBe("qa-room");
    expect(resolved?.parentConversationCandidates).toEqual(["qa-room"]);
  });

  it("recovers thread-aware outbound session routes from currentSessionKey", async () => {
    const route = await qaChannelPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "channel:qa-room",
      currentSessionKey: "agent:main:qa-channel:channel:channel:qa-room:thread:thread-1",
    });

    expect(route?.sessionKey).toBe("agent:main:qa-channel:channel:channel:qa-room:thread:thread-1");
    expect(route?.baseSessionKey).toBe("agent:main:qa-channel:channel:channel:qa-room");
    expect(route?.threadId).toBe("thread-1");
  });

  it('does not recover currentSessionKey threads for shared dmScope "main" DMs', async () => {
    const route = await qaChannelPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "dm:alice",
      currentSessionKey: "agent:main:main:thread:thread-1",
    });

    expect(route?.sessionKey).toBe("agent:main:main");
    expect(route?.baseSessionKey).toBe("agent:main:main");
    expect(route?.threadId).toBeUndefined();
  });

  it("backs declared message adapter capabilities with qa bus sends", async () => {
    const harness = await startQaChannelTestHarness({ allowFrom: ["*"] });
    try {
      const adapter = requireQaMessageAdapter();

      const proveText = async () => {
        const result = await adapter.send!.text!({
          cfg: createQaChannelConfig({ baseUrl: harness.baseUrl, allowFrom: ["*"] }),
          to: "thread:qa-room/thread-1",
          text: "hello",
          accountId: "default",
          replyToId: "parent-1",
          threadId: "thread-1",
        });
        const receiptPart = result.receipt.parts[0];
        expect(receiptPart?.kind).toBe("text");
        expect(receiptPart?.replyToId).toBe("parent-1");
        expect(receiptPart?.threadId).toBe("thread-1");
      };

      await verifyChannelMessageAdapterCapabilityProofs({
        adapterName: "qaChannelMessageAdapter",
        adapter,
        proofs: {
          text: proveText,
          replyTo: proveText,
          thread: proveText,
          messageSendingHooks: () => {
            expect(adapter.send!.text).toBeTypeOf("function");
          },
        },
      });
    } finally {
      await harness.stop();
    }
  });

  it("roundtrips inbound DM traffic through the qa bus", { timeout: 20_000 }, async () => {
    const harness = await startQaChannelTestHarness({ allowFrom: ["*"] });

    try {
      harness.state.addInboundMessage({
        conversation: { id: "alice", kind: "direct" },
        senderId: "alice",
        senderName: "Alice",
        text: "hello",
      });

      const outbound = await harness.state.waitFor({
        kind: "message-text",
        textIncludes: "qa-echo: hello",
        direction: "outbound",
        timeoutMs: 15_000,
      });
      expect("text" in outbound && outbound.text).toContain("qa-echo: hello");
    } finally {
      await harness.stop();
    }
  });

  it(
    "surfaces shared group traffic with the room target as From",
    { timeout: 20_000 },
    async () => {
      let dispatchedCtx: Record<string, unknown> | null = null;
      const harness = await startQaChannelTestHarness({
        allowFrom: ["*"],
        runtime: createMockQaRuntime({
          onDispatch: (ctx) => {
            dispatchedCtx = ctx;
          },
        }),
      });

      try {
        harness.state.addInboundMessage({
          conversation: { id: "qa-room", kind: "group", title: "QA Room" },
          senderId: "alice",
          senderName: "Alice",
          text: "@openclaw hello",
        });

        const outbound = await harness.state.waitFor({
          kind: "message-text",
          textIncludes: "qa-echo: @openclaw hello",
          direction: "outbound",
          timeoutMs: 15_000,
        });

        const ctx = expectDispatchedContext(dispatchedCtx);
        expect(ctx.ChatType).toBe("group");
        expect(ctx.From).toBe("group:qa-room");
        expect(ctx.To).toBe("group:qa-room");
        expect(ctx.SessionKey).toBe("qa-agent:group:group:qa-room");
        expect(ctx.SenderId).toBe("alice");
        expect(ctx.GroupSubject).toBe("QA Room");
        expect("conversation" in outbound).toBe(true);
        if (!("conversation" in outbound)) {
          throw new Error("expected outbound message conversation");
        }
        expect(outbound.conversation.id).toBe("qa-room");
        expect(outbound.conversation.kind).toBe("group");
      } finally {
        await harness.stop();
      }
    },
  );

  it("stages inbound image attachments into agent media payload", { timeout: 20_000 }, async () => {
    let dispatchedCtx: Record<string, unknown> | null = null;
    const harness = await startQaChannelTestHarness({
      allowFrom: ["*"],
      runtime: createMockQaRuntime({
        onDispatch: (ctx) => {
          dispatchedCtx = ctx;
        },
      }),
    });

    try {
      harness.state.addInboundMessage({
        conversation: { id: "alice", kind: "direct" },
        senderId: "alice",
        senderName: "Alice",
        text: "describe this image",
        attachments: [
          {
            id: "image-1",
            kind: "image",
            mimeType: "image/png",
            fileName: "red-top-blue-bottom.png",
            contentBase64:
              "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8Dwn4GBgYGJAQoAHxcCAr7cGDwAAAAASUVORK5CYII=",
          },
        ],
      });

      await harness.state.waitFor({
        kind: "message-text",
        textIncludes: "qa-echo: describe this image",
        direction: "outbound",
        timeoutMs: 15_000,
      });

      const mediaCtx = expectDispatchedContext(dispatchedCtx) as {
        MediaPath?: string;
        MediaPaths?: string[];
        MediaType?: string;
        MediaTypes?: string[];
      };
      expect(typeof mediaCtx.MediaPath).toBe("string");
      expect(path.basename(mediaCtx.MediaPath ?? "")).toMatch(
        /^red-top-blue-bottom---[a-f0-9-]{36}\.png$/,
      );
      expect(mediaCtx.MediaType).toBe("image/png");
      expect(mediaCtx.MediaPaths).toEqual([mediaCtx.MediaPath]);
      expect(mediaCtx.MediaTypes).toEqual(["image/png"]);
    } finally {
      await harness.stop();
    }
  });

  it("exposes thread and message actions against the qa bus", async () => {
    installQaChannelTestRegistry();
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });

    try {
      const cfg = createQaChannelConfig({ baseUrl: bus.baseUrl });

      const handleAction = requireQaActionHandler();

      const threadResult = await handleAction({
        channel: "qa-channel",
        action: "thread-create",
        cfg,
        accountId: "default",
        params: {
          channelId: "qa-room",
          title: "QA thread",
        },
      });
      const threadPayload = extractToolPayload(threadResult) as {
        thread: { id: string };
        target: string;
      };
      expect(threadPayload.thread.id).toMatch(/^thread-/);
      expect(threadPayload.target).toContain(threadPayload.thread.id);

      const outbound = state.addOutboundMessage({
        to: threadPayload.target,
        text: "message",
        threadId: threadPayload.thread.id,
      });

      await handleAction({
        channel: "qa-channel",
        action: "react",
        cfg,
        accountId: "default",
        params: {
          messageId: outbound.id,
          emoji: "white_check_mark",
        },
      });

      await handleAction({
        channel: "qa-channel",
        action: "edit",
        cfg,
        accountId: "default",
        params: {
          messageId: outbound.id,
          text: "message (edited)",
        },
      });

      const readResult = await handleAction({
        channel: "qa-channel",
        action: "read",
        cfg,
        accountId: "default",
        params: {
          messageId: outbound.id,
        },
      });
      const readPayload = extractToolPayload(readResult) as { message: { text: string } };
      expect(readPayload.message.text).toContain("(edited)");

      const searchResult = await handleAction({
        channel: "qa-channel",
        action: "search",
        cfg,
        accountId: "default",
        params: {
          query: "edited",
          channelId: "qa-room",
          threadId: threadPayload.thread.id,
        },
      });
      const searchPayload = extractToolPayload(searchResult) as {
        messages: Array<{ id: string }>;
      };
      expect(searchPayload.messages.map((message) => message.id)).toContain(outbound.id);

      await handleAction({
        channel: "qa-channel",
        action: "delete",
        cfg,
        accountId: "default",
        params: {
          messageId: outbound.id,
        },
      });
      expect(state.readMessage({ messageId: outbound.id }).deleted).toBe(true);
    } finally {
      await bus.stop();
    }
  });

  it("routes the advertised send action to the qa bus", async () => {
    installQaChannelTestRegistry();
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });

    try {
      const cfg = createQaChannelConfig({ baseUrl: bus.baseUrl });

      const sendTarget = qaChannelPlugin.actions?.extractToolSend?.({
        args: {
          action: "send",
          target: "qa-room",
          message: "hello",
        },
      });
      expect(sendTarget).toEqual({ to: "channel:qa-room", threadId: undefined });

      const result = await qaChannelPlugin.actions?.handleAction?.({
        channel: "qa-channel",
        action: "send",
        cfg,
        accountId: "default",
        params: {
          target: "qa-room",
          message: "hello from action",
        },
      });
      const payload = extractToolPayload(result) as { message: { text: string } };
      expect(payload.message.text).toBe("hello from action");

      const outbound = await state.waitFor({
        kind: "message-text",
        direction: "outbound",
        textIncludes: "hello from action",
        timeoutMs: 5_000,
      });
      expect("conversation" in outbound).toBe(true);
      if (!("conversation" in outbound)) {
        throw new Error("expected outbound message match");
      }
      expect(outbound.conversation.id).toBe("qa-room");
      expect(outbound.conversation.kind).toBe("channel");
    } finally {
      await bus.stop();
    }
  });

  it("routes group send targets to group qa bus conversations", async () => {
    installQaChannelTestRegistry();
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });

    try {
      const cfg = createQaChannelConfig({ baseUrl: bus.baseUrl });

      const result = await qaChannelPlugin.actions?.handleAction?.({
        channel: "qa-channel",
        action: "send",
        cfg,
        accountId: "default",
        params: {
          target: "group:qa-room",
          message: "hello group",
        },
      });
      const payload = extractToolPayload(result) as { message: { text: string } };
      expect(payload.message.text).toBe("hello group");

      const outbound = await state.waitFor({
        kind: "message-text",
        direction: "outbound",
        textIncludes: "hello group",
        timeoutMs: 5_000,
      });
      expect("conversation" in outbound).toBe(true);
      if (!("conversation" in outbound)) {
        throw new Error("expected outbound message match");
      }
      expect(outbound.conversation.id).toBe("qa-room");
      expect(outbound.conversation.kind).toBe("group");
    } finally {
      await bus.stop();
    }
  });
});
