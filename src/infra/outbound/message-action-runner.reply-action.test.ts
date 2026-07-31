// Covers reply-type plugin actions: outbound text hygiene (citation control
// markers) and current-source delivery marking for implicit reply routes.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";

type ChannelActionHandler = NonNullable<NonNullable<ChannelPlugin["actions"]>["handleAction"]>;

const testchatConfig = {
  channels: {
    testchat: {
      enabled: true,
    },
  },
} as OpenClawConfig;

const CITATION_MARKED_MESSAGE = "Ayutthaya Thai is my pick. citeturn2search9turn2search6";

function createReplyActionPlugin(handleAction: ChannelActionHandler): ChannelPlugin {
  return {
    id: "testchat",
    meta: {
      id: "testchat",
      label: "Test Chat",
      selectionLabel: "Test Chat",
      docsPath: "/channels/testchat",
      blurb: "Reply action test plugin.",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({ enabled: true }),
      isConfigured: () => true,
    },
    outbound: {
      deliveryMode: "direct",
      sendText: async () => ({ channel: "testchat", messageId: "m-send-1" }),
    },
    messaging: {
      targetResolver: {
        looksLikeId: () => true,
      },
    },
    actions: {
      describeMessageTool: () => ({ actions: ["reply", "poll"] }),
      supportsAction: ({ action }) => action === "reply" || action === "poll",
      handleAction,
    },
  };
}

function registerReplyPlugin() {
  const payload = { ok: true, messageId: "m-reply-1", repliedTo: "platform-guid-1" };
  const handleAction = vi.fn(async () => ({
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: payload,
  }));
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "testchat", source: "test", plugin: createReplyActionPlugin(handleAction) },
    ]),
  );
  return handleAction;
}

function readHandledParams(handleAction: {
  mock: { calls: readonly unknown[][] };
}): Record<string, unknown> {
  const [call] = handleAction.mock.calls;
  const arg = call?.[0];
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    throw new Error("expected plugin handleAction call");
  }
  const params = (arg as Record<string, unknown>).params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("expected plugin handleAction params");
  }
  return params as Record<string, unknown>;
}

async function runReplyAction(params: {
  actionParams: Record<string, unknown>;
  currentMessageId?: string | number;
}) {
  const toolContext = {
    currentChannelProvider: "testchat" as const,
    currentChannelId: "direct:user-1",
    ...(params.currentMessageId !== undefined ? { currentMessageId: params.currentMessageId } : {}),
  };
  return await runMessageAction({
    cfg: testchatConfig,
    action: "reply",
    params: { channel: "testchat", ...params.actionParams },
    toolContext,
    messageActionAuthorization: {
      requesterAccountId: "default",
      toolContext,
    },
    sessionKey: "agent:main:testchat:direct:user-1",
    defaultAccountId: "default",
    sourceReplyDeliveryMode: "message_tool_only",
    dryRun: false,
  });
}

async function runPollAction(params: { to: string }) {
  const toolContext = {
    currentChannelProvider: "testchat" as const,
    currentChannelId: "direct:user-1",
    currentMessageId: "1783",
  };
  return await runMessageAction({
    cfg: testchatConfig,
    action: "poll",
    params: {
      channel: "testchat",
      to: params.to,
      pollQuestion: "Preferred default?",
      pollOption: ["Tell me right away", "Only important"],
    },
    toolContext,
    messageActionAuthorization: {
      requesterAccountId: "default",
      toolContext,
    },
    sessionKey: "agent:main:testchat:direct:user-1",
    defaultAccountId: "default",
    sourceReplyDeliveryMode: "message_tool_only",
    dryRun: false,
  });
}

describe("runMessageAction reply-type plugin actions", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("strips citation control markers from reply text before plugin dispatch", async () => {
    const handleAction = registerReplyPlugin();

    await runReplyAction({
      actionParams: { message: CITATION_MARKED_MESSAGE, messageId: "1783" },
      currentMessageId: "1783",
    });

    const handledParams = readHandledParams(handleAction);
    expect(handledParams.message).toBe("Ayutthaya Thai is my pick.");
  });

  it("marks replies to the run's inbound message as current-source deliveries", async () => {
    registerReplyPlugin();

    const result = await runReplyAction({
      actionParams: { message: "visible reply", messageId: "1783" },
      currentMessageId: "1783",
    });

    expect(result.kind).toBe("action");
    expect(result.payload).toMatchObject({ sourceReplyRoute: "current-source" });
    const details = "toolResult" in result ? result.toolResult?.details : undefined;
    expect(details).toMatchObject({ sourceReplyRoute: "current-source" });
  });

  it("matches numeric replied-to message ids against string tool-context ids", async () => {
    registerReplyPlugin();

    const result = await runReplyAction({
      actionParams: { message: "visible reply", messageId: 1783 },
      currentMessageId: "1783",
    });

    expect(result.payload).toMatchObject({ sourceReplyRoute: "current-source" });
  });

  it("leaves replies to other messages unmarked", async () => {
    registerReplyPlugin();

    const result = await runReplyAction({
      actionParams: { message: "visible reply", messageId: "999" },
      currentMessageId: "1783",
    });

    expect((result.payload as { sourceReplyRoute?: unknown }).sourceReplyRoute).toBeUndefined();
  });

  it("leaves explicitly targeted replies unmarked", async () => {
    registerReplyPlugin();

    const result = await runReplyAction({
      actionParams: {
        message: "visible reply",
        messageId: "1783",
        to: "direct:someone-else",
      },
      currentMessageId: "1783",
    });

    expect((result.payload as { sourceReplyRoute?: unknown }).sourceReplyRoute).toBeUndefined();
  });

  it("marks polls sent to the current conversation as current-source deliveries", async () => {
    registerReplyPlugin();

    const result = await runPollAction({ to: "direct:user-1" });

    expect(result.kind).toBe("poll");
    expect(result.payload).toMatchObject({ sourceReplyRoute: "current-source" });
  });

  it("leaves polls sent to other conversations unmarked", async () => {
    registerReplyPlugin();

    const result = await runPollAction({ to: "direct:someone-else" });

    expect((result.payload as { sourceReplyRoute?: unknown }).sourceReplyRoute).toBeUndefined();
  });
});
