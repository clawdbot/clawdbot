import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import { extractToolPayload } from "../../../src/infra/outbound/tool-payload.js";
import { createStartAccountContext } from "../../../test/helpers/plugins/start-account-context.js";
import { createQaBusState, startQaBusServer } from "../../qa-lab/api.js";
import { qaChannelPlugin } from "../api.js";
import { setQaChannelRuntime } from "../api.js";

function createMockQaRuntime(): PluginRuntime {
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
          await dispatcherOptions.deliver({
            text: `qa-echo: ${ctx.BodyForAgent ?? ctx.Body ?? ""}`,
          });
        },
      },
    },
  } as unknown as PluginRuntime;
}

describe("qa-channel plugin", () => {
  it("roundtrips inbound DM traffic through the qa bus", { timeout: 20_000 }, async () => {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    setQaChannelRuntime(createMockQaRuntime());

    const cfg = {
      channels: {
        "qa-channel": {
          baseUrl: bus.baseUrl,
          botUserId: "openclaw",
          botDisplayName: "OpenClaw QA",
          allowFrom: ["*"],
        },
      },
    };
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

    try {
      state.addInboundMessage({
        conversation: { id: "alice", kind: "direct" },
        senderId: "alice",
        senderName: "Alice",
        text: "hello",
      });

      const outbound = await state.waitFor({
        kind: "message-text",
        textIncludes: "qa-echo: hello",
        direction: "outbound",
        timeoutMs: 15_000,
      });
      expect("text" in outbound && outbound.text).toContain("qa-echo: hello");
    } finally {
      abort.abort();
      await task;
      await bus.stop();
    }
  });

  it("exposes thread and message actions against the qa bus", async () => {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });

    try {
      const cfg = {
        channels: {
          "qa-channel": {
            baseUrl: bus.baseUrl,
            botUserId: "openclaw",
            botDisplayName: "OpenClaw QA",
          },
        },
      };

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
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });

    try {
      const cfg = {
        channels: {
          "qa-channel": {
            baseUrl: bus.baseUrl,
            botUserId: "openclaw",
            botDisplayName: "OpenClaw QA",
          },
        },
      };

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
