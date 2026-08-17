import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { extractToolPayload } from "openclaw/plugin-sdk/tool-payload";
import { afterEach, describe, expect, it } from "vitest";
import { createQaBusState, startQaBusServer } from "../../qa-lab/bus-api.js";
import { qaChannelPlugin } from "../api.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

function installQaChannelTestRegistry() {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "qa-channel", plugin: qaChannelPlugin, source: "test" }]),
  );
}

function createQaChannelConfig(baseUrl: string) {
  return {
    channels: {
      "qa-channel": {
        baseUrl,
        botUserId: "openclaw",
        botDisplayName: "OpenClaw QA",
      },
    },
  };
}

function requireQaActionHandler() {
  const handleAction = qaChannelPlugin.actions?.handleAction;
  if (!handleAction) {
    throw new Error("expected qa-channel action handler");
  }
  return handleAction;
}

describe("qa-channel direct message actions", () => {
  it("exposes thread and message actions against the qa bus", async () => {
    installQaChannelTestRegistry();
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });

    try {
      const cfg = createQaChannelConfig(bus.baseUrl);

      const handleAction = requireQaActionHandler();
      const discovery = qaChannelPlugin.actions?.describeMessageTool?.({
        cfg,
        accountId: "default",
      });
      const schema = discovery?.schema;
      const contributions = Array.isArray(schema) ? schema : schema ? [schema] : [];
      const titleSchema = contributions.find((entry) => "title" in entry.properties)?.properties
        .title;
      expect(titleSchema).toMatchObject({
        description: "Deprecated alias for threadName.",
      });

      const threadResult = await handleAction({
        channel: "qa-channel",
        action: "thread-create",
        cfg,
        accountId: "default",
        params: {
          target: "channel:qa-room",
          threadName: "QA thread",
          title: "ignored legacy title",
        },
      });
      const threadPayload = extractToolPayload(threadResult) as {
        thread: { id: string; title: string };
        target: string;
      };
      expect(threadPayload.thread.id).toMatch(/^thread-/);
      expect(threadPayload.thread.title).toBe("QA thread");
      expect(threadPayload.target).toContain(threadPayload.thread.id);

      const replyResult = await handleAction({
        channel: "qa-channel",
        action: "thread-reply",
        cfg,
        accountId: "default",
        params: {
          target: threadPayload.target,
          message: "thread reply",
          text: "ignored legacy reply",
        },
      });
      const replyPayload = extractToolPayload(replyResult) as {
        message: { text: string; threadId: string };
      };
      expect(replyPayload.message).toMatchObject({
        text: "thread reply",
        threadId: threadPayload.thread.id,
      });

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
          to: threadPayload.target,
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
          target: threadPayload.target,
          messageId: outbound.id,
          message: "message (edited)",
          text: "ignored legacy edit",
        },
      });

      const readResult = await handleAction({
        channel: "qa-channel",
        action: "read",
        cfg,
        accountId: "default",
        params: {
          to: threadPayload.target,
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
          to: threadPayload.target,
          messageId: outbound.id,
        },
      });
      expect(state.readMessage({ messageId: outbound.id }).deleted).toBe(true);
    } finally {
      await bus.stop();
    }
  });

  it("prefers canonical targets over conflicting direct-adapter aliases", async () => {
    installQaChannelTestRegistry();
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });

    try {
      const cfg = createQaChannelConfig(bus.baseUrl);
      const handleAction = requireQaActionHandler();
      const threadResult = await handleAction({
        channel: "qa-channel",
        action: "thread-create",
        cfg,
        accountId: "default",
        params: {
          target: "channel:canonical-room",
          to: "channel:legacy-to-room",
          channelId: "legacy-channel-id-room",
          threadName: "Canonical target thread",
        },
      });
      const threadPayload = extractToolPayload(threadResult) as {
        thread: { id: string; conversationId: string };
        target: string;
      };

      expect(threadPayload.thread.conversationId).toBe("canonical-room");
      expect(threadPayload.target).toBe(`thread:canonical-room/${threadPayload.thread.id}`);

      const replyResult = await handleAction({
        channel: "qa-channel",
        action: "thread-reply",
        cfg,
        accountId: "default",
        params: {
          target: threadPayload.target,
          channelId: "legacy-reply-room",
          message: "canonical target reply",
        },
      });
      expect(extractToolPayload(replyResult)).toMatchObject({
        message: {
          conversation: { id: "canonical-room", kind: "channel" },
          text: "canonical target reply",
          threadId: threadPayload.thread.id,
        },
      });
    } finally {
      await bus.stop();
    }
  });

  it("keeps the shipped thread and edit aliases for direct API callers", async () => {
    installQaChannelTestRegistry();
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });

    try {
      const cfg = createQaChannelConfig(bus.baseUrl);
      const handleAction = requireQaActionHandler();
      const threadResult = await handleAction({
        channel: "qa-channel",
        action: "thread-create",
        cfg,
        accountId: "default",
        params: {
          channelId: "qa-room",
          title: "Legacy thread",
        },
      });
      const threadPayload = extractToolPayload(threadResult) as {
        thread: { id: string; title: string };
        target: string;
      };
      expect(threadPayload.thread.title).toBe("Legacy thread");

      const replyResult = await handleAction({
        channel: "qa-channel",
        action: "thread-reply",
        cfg,
        accountId: "default",
        params: {
          channelId: "qa-room",
          threadId: threadPayload.thread.id,
          text: "legacy reply",
        },
      });
      expect(extractToolPayload(replyResult)).toMatchObject({
        message: {
          text: "legacy reply",
          threadId: threadPayload.thread.id,
        },
      });

      const outbound = state.addOutboundMessage({
        to: threadPayload.target,
        text: "before legacy edit",
        threadId: threadPayload.thread.id,
      });
      const editResult = await handleAction({
        channel: "qa-channel",
        action: "edit",
        cfg,
        accountId: "default",
        params: {
          to: threadPayload.target,
          messageId: outbound.id,
          text: "legacy edit",
        },
      });
      expect(extractToolPayload(editResult)).toMatchObject({
        message: { text: "legacy edit" },
      });
      expect(state.readMessage({ messageId: outbound.id }).text).toBe("legacy edit");
    } finally {
      await bus.stop();
    }
  });
});
