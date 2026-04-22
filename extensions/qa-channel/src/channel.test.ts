import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { extractToolPayload } from "../../../src/infra/outbound/tool-payload.js";
import { createTestRegistry } from "../../../test/helpers/plugins/plugin-registry.js";
import { createStartAccountContext } from "../../../test/helpers/plugins/start-account-context.js";
import { createQaBusState, startQaBusServer } from "../../qa-lab/api.js";
import { qaChannelPlugin, setQaChannelRuntime } from "../api.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

function installQaChannelTestRegistry() {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "qa-channel", plugin: qaChannelPlugin, source: "test" }]),
  );
}

function createMockQaRuntime(params?: {
  onDispatch?: (ctx: Record<string, unknown>) => void;
}): PluginRuntime {
  const sessionUpdatedAt = new Map<string, number>();
  return {
    channel: {
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
    },
  } as unknown as PluginRuntime;
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
  const startAccount = qaChannelPlugin.gateway?.startAccount;
  expect(startAccount).toBeDefined();
  const task = startAccount!(
    createStartAccountContext({
      account,
      cfg,
      abortSignal: abort.signal,
    }),
  );
  return {
    state,
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

    expect(route).toMatchObject({
      sessionKey: "agent:main:qa-channel:channel:thread:qa-room/thread-1",
      baseSessionKey: "agent:main:qa-channel:channel:thread:qa-room/thread-1",
    });
    expect(route?.threadId).toBeUndefined();
  });

  it("recovers thread-aware outbound session routes from currentSessionKey", async () => {
    const route = await qaChannelPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "channel:qa-room",
      currentSessionKey: "agent:main:qa-channel:channel:channel:qa-room:thread:thread-1",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:qa-channel:channel:channel:qa-room:thread:thread-1",
      baseSessionKey: "agent:main:qa-channel:channel:channel:qa-room",
      threadId: "thread-1",
    });
  });

  it('does not recover currentSessionKey threads for shared dmScope "main" DMs', async () => {
    const route = await qaChannelPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "dm:alice",
      currentSessionKey: "agent:main:main:thread:thread-1",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
    });
    expect(route?.threadId).toBeUndefined();
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

      expect(dispatchedCtx).not.toBeNull();
      if (!dispatchedCtx) {
        throw new Error("expected dispatched context");
      }
      const mediaCtx: {
        MediaPath?: string;
        MediaPaths?: string[];
        MediaType?: string;
        MediaTypes?: string[];
      } = dispatchedCtx;
      expect(mediaCtx.MediaPath).toEqual(expect.stringContaining("red-top-blue-bottom"));
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

      const handleAction = qaChannelPlugin.actions?.handleAction;
      expect(handleAction).toBeDefined();

      const threadResult = await handleAction!({
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
      expect(threadPayload.thread.id).toBeTruthy();
      expect(threadPayload.target).toContain(threadPayload.thread.id);

      const outbound = state.addOutboundMessage({
        to: threadPayload.target,
        text: "message",
        threadId: threadPayload.thread.id,
      });

      await handleAction!({
        channel: "qa-channel",
        action: "react",
        cfg,
        accountId: "default",
        params: {
          messageId: outbound.id,
          emoji: "white_check_mark",
        },
      });

      await handleAction!({
        channel: "qa-channel",
        action: "edit",
        cfg,
        accountId: "default",
        params: {
          messageId: outbound.id,
          text: "message (edited)",
        },
      });

      const readResult = await handleAction!({
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

      const searchResult = await handleAction!({
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
      expect(searchPayload.messages.some((message) => message.id === outbound.id)).toBe(true);

      await handleAction!({
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
      const payload = extractToolPayload(result);
      expect(payload).toMatchObject({ message: { text: "hello from action" } });

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
      expect(outbound.conversation).toMatchObject({ id: "qa-room", kind: "channel" });
    } finally {
      await bus.stop();
    }
  });
});
