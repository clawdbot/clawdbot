import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { slackPlugin } from "./channel.js";
import { slackOutbound } from "./outbound-adapter.js";
import * as probeModule from "./probe.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { clearSlackRuntime, setSlackRuntime } from "./runtime.js";

const { handleSlackActionMock } = vi.hoisted(() => ({
  handleSlackActionMock: vi.fn(),
}));
const { sendMessageSlackMock } = vi.hoisted(() => ({
  sendMessageSlackMock: vi.fn(),
}));
const { conversationsInfoMock, conversationsOpenMock } = vi.hoisted(() => ({
  conversationsInfoMock: vi.fn(),
  conversationsOpenMock: vi.fn(),
}));

vi.mock("./action-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./action-runtime.js")>("./action-runtime.js");
  return {
    ...actual,
    handleSlackAction: handleSlackActionMock,
  };
});

vi.mock("./send.runtime.js", () => ({
  sendMessageSlack: sendMessageSlackMock,
}));

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    createSlackWebClient: vi.fn(() => ({
      conversations: {
        info: conversationsInfoMock,
        open: conversationsOpenMock,
      },
    })),
  };
});

beforeEach(async () => {
  handleSlackActionMock.mockReset();
  sendMessageSlackMock.mockReset();
  sendMessageSlackMock.mockResolvedValue({ messageId: "msg-1", channelId: "D123" });
  conversationsInfoMock.mockReset();
  conversationsOpenMock.mockReset();
  setSlackRuntime({
    channel: {
      slack: {
        handleSlackAction: handleSlackActionMock,
      },
    },
  } as never);
});

async function getSlackConfiguredState(cfg: OpenClawConfig) {
  const account = slackPlugin.config.resolveAccount(cfg, "default");
  return {
    configured: slackPlugin.config.isConfigured?.(account, cfg),
    snapshot: await slackPlugin.status?.buildAccountSnapshot?.({
      account,
      cfg,
      runtime: undefined,
    }),
  };
}

function requireSlackHandleAction() {
  const handleAction = slackPlugin.actions?.handleAction;
  if (!handleAction) {
    throw new Error("slack actions.handleAction unavailable");
  }
  return handleAction;
}

function requireSlackSendText() {
  const sendText = slackPlugin.outbound?.sendText;
  if (!sendText) {
    throw new Error("slack outbound.sendText unavailable");
  }
  return sendText;
}

function requireSlackSendMedia() {
  const sendMedia = slackPlugin.outbound?.sendMedia;
  if (!sendMedia) {
    throw new Error("slack outbound.sendMedia unavailable");
  }
  return sendMedia;
}

function requireSlackSendPayload() {
  const sendPayload = slackPlugin.outbound?.sendPayload ?? slackOutbound.sendPayload;
  if (!sendPayload) {
    throw new Error("slack outbound.sendPayload unavailable");
  }
  return sendPayload;
}

function requireSlackListPeers() {
  const listPeers = slackPlugin.directory?.listPeers;
  if (!listPeers) {
    throw new Error("slack directory.listPeers unavailable");
  }
  return listPeers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${label} to be an array`);
  }
  return value;
}

function expectRecordFields(value: unknown, label: string, expected: Record<string, unknown>) {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key]).toEqual(expectedValue);
  }
}

function requireMockCallArg(mock: ReturnType<typeof vi.fn>, callIndex: number, argIndex: number) {
  return requireRecord(mock.mock.calls[callIndex]?.[argIndex], "mock call argument");
}

function findSchemaEntry(
  schema: unknown,
  actions: string[],
  label: string,
): Record<string, unknown> {
  const entries = requireArray(schema, label);
  const entry = entries.find((candidate) => {
    const record = requireRecord(candidate, `${label} entry`);
    return JSON.stringify(record.actions) === JSON.stringify(actions);
  });
  return requireRecord(entry, `${label} ${actions.join(",")} entry`);
}

describe("slackPlugin actions", () => {
  it("prefers session lookup for announce target routing", () => {
    expect(slackPlugin.meta.preferSessionLookupForAnnounceTarget).toBe(true);
  });

  it("owns unified message tool discovery", () => {
    const discovery = slackPlugin.actions?.describeMessageTool({
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-test",
            appToken: "xapp-test",
            capabilities: { interactiveReplies: true },
          },
        },
      },
    });

    expect(discovery?.actions).toContain("send");
    expect(discovery?.capabilities).toContain("presentation");
    const downloadFile = findSchemaEntry(discovery?.schema, ["download-file"], "Slack schema");
    const downloadProperties = requireRecord(downloadFile.properties, "download-file properties");
    expect(isRecord(downloadProperties.fileId)).toBe(true);
  });

  it("honors the selected Slack account during message tool discovery", () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          botToken: "xoxb-root",
          appToken: "xapp-root",
          actions: {
            reactions: false,
            messages: false,
            pins: false,
            memberInfo: false,
            emojiList: false,
          },
          capabilities: {
            interactiveReplies: false,
          },
          accounts: {
            default: {
              botToken: "xoxb-default",
              appToken: "xapp-default",
              actions: {
                reactions: false,
                messages: false,
                pins: false,
                memberInfo: false,
                emojiList: false,
              },
              capabilities: {
                interactiveReplies: false,
              },
            },
            work: {
              botToken: "xoxb-work",
              appToken: "xapp-work",
              actions: {
                reactions: true,
                messages: true,
                pins: false,
                memberInfo: false,
                emojiList: false,
              },
              capabilities: {
                interactiveReplies: true,
              },
            },
          },
        },
      },
    };

    expectRecordFields(
      slackPlugin.actions?.describeMessageTool?.({ cfg, accountId: "default" }),
      "default message tool discovery",
      {
        actions: ["send"],
        capabilities: ["presentation"],
      },
    );
    const workDiscovery = requireRecord(
      slackPlugin.actions?.describeMessageTool?.({ cfg, accountId: "work" }),
      "work message tool discovery",
    );
    expectRecordFields(workDiscovery, "work message tool discovery", {
      actions: [
        "send",
        "react",
        "reactions",
        "read",
        "edit",
        "delete",
        "download-file",
        "upload-file",
      ],
    });
    expect(requireArray(workDiscovery.capabilities, "work capabilities")).toContain("presentation");
  });

  it("uses configured defaultAccount for pairing approval notifications", async () => {
    const cfg = {
      channels: {
        slack: {
          defaultAccount: "work",
          accounts: {
            work: {
              botToken: "xoxb-work",
            },
          },
        },
      },
    } as OpenClawConfig;
    setSlackRuntime({
      config: {
        loadConfig: () => cfg,
      },
    } as never);

    const notify = slackPlugin.pairing?.notifyApproval;
    if (!notify) {
      throw new Error("slack pairing notify unavailable");
    }

    await notify({
      cfg,
      id: "U12345678",
    });

    expect(sendMessageSlackMock.mock.calls[0]?.[0]).toBe("user:U12345678");
    expect(String(sendMessageSlackMock.mock.calls[0]?.[1])).toContain("approved");
    expectRecordFields(requireMockCallArg(sendMessageSlackMock, 0, 2), "send options", {
      accountId: "work",
      cfg,
      token: "xoxb-work",
    });
  });

  it("exposes Slack-native message id and file id schema hints", () => {
    const discovery = slackPlugin.actions?.describeMessageTool({
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-test",
            appToken: "xapp-test",
          },
        },
      } as OpenClawConfig,
    });
    const downloadFile = findSchemaEntry(discovery?.schema, ["download-file"], "Slack schema");
    const downloadProperties = requireRecord(downloadFile.properties, "download-file properties");
    expect(isRecord(downloadProperties.fileId)).toBe(true);

    const messageActions = findSchemaEntry(
      discovery?.schema,
      ["react", "reactions", "edit", "delete", "pin", "unpin"],
      "Slack schema",
    );
    const messageProperties = requireRecord(messageActions.properties, "message properties");
    expect(isRecord(messageProperties.messageId)).toBe(true);
    expect(isRecord(messageProperties.message_id)).toBe(true);
  });

  it("treats interactive reply payloads as structured Slack payloads", () => {
    const hasStructuredReplyPayload = slackPlugin.messaging?.hasStructuredReplyPayload;
    if (!hasStructuredReplyPayload) {
      throw new Error("slack messaging.hasStructuredReplyPayload unavailable");
    }

    expect(
      hasStructuredReplyPayload({
        payload: {
          text: "Choose",
          interactive: {
            blocks: [{ type: "buttons", buttons: [{ label: "Retry", value: "retry" }] }],
          },
        },
      }),
    ).toBe(true);
  });

  it("forwards read threadId to Slack action handler", async () => {
    handleSlackActionMock.mockResolvedValueOnce({ messages: [], hasMore: false });
    const handleAction = requireSlackHandleAction();

    await handleAction({
      action: "read",
      channel: "slack",
      accountId: "default",
      cfg: {},
      params: {
        channelId: "C123",
        threadId: "1712345678.123456",
        messageId: "1712345678.654321",
      },
    });

    expectRecordFields(requireMockCallArg(handleSlackActionMock, 0, 0), "Slack action", {
      action: "readMessages",
      channelId: "C123",
      threadId: "1712345678.123456",
      messageId: "1712345678.654321",
    });
    expect(handleSlackActionMock.mock.calls[0]?.[1]).toEqual({});
    expect(handleSlackActionMock.mock.calls[0]?.[2]).toBeUndefined();
  });

  it("forwards media access through the bundled Slack action invoke path", async () => {
    handleSlackActionMock.mockResolvedValueOnce({ ok: true });
    const handleAction = requireSlackHandleAction();
    const mediaLocalRoots = ["/tmp/workspace-agent"];
    const mediaReadFile = vi.fn(async () => Buffer.from("file"));

    await handleAction({
      action: "upload-file",
      channel: "slack",
      accountId: "default",
      cfg: {},
      params: {
        to: "channel:C123",
        filePath: "/tmp/workspace-agent/renders/file.wav",
        initialComment: "render",
      },
      mediaLocalRoots,
      mediaReadFile,
      toolContext: {
        currentChannelId: "C123",
        replyToMode: "all",
      },
    } as never);

    expectRecordFields(requireMockCallArg(handleSlackActionMock, 0, 0), "Slack action", {
      action: "uploadFile",
      to: "channel:C123",
      filePath: "/tmp/workspace-agent/renders/file.wav",
      initialComment: "render",
    });
    expect(handleSlackActionMock.mock.calls[0]?.[1]).toEqual({});
    expectRecordFields(requireMockCallArg(handleSlackActionMock, 0, 2), "Slack action context", {
      currentChannelId: "C123",
      replyToMode: "all",
      mediaLocalRoots,
      mediaReadFile,
    });
  });
});

describe("slackPlugin status", () => {
  it("uses the direct Slack probe helper when runtime is not initialized", async () => {
    const probeSpy = vi.spyOn(probeModule, "probeSlack").mockResolvedValueOnce({
      ok: true,
      status: 200,
      bot: { id: "B1", name: "openclaw-bot" },
      team: { id: "T1", name: "OpenClaw" },
    });
    clearSlackRuntime();
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          appToken: "xapp-test",
        },
      },
    } as OpenClawConfig;
    const account = slackPlugin.config.resolveAccount(cfg, "default");

    const result = await slackPlugin.status!.probeAccount!({
      account,
      timeoutMs: 2500,
      cfg,
    });

    expect(probeSpy).toHaveBeenCalledWith("xoxb-test", 2500);
    expect(result).toEqual({
      ok: true,
      status: 200,
      bot: { id: "B1", name: "openclaw-bot" },
      team: { id: "T1", name: "OpenClaw" },
    });
  });

  it("recovers thread routing from mixed-case Slack session keys", async () => {
    const resolveRoute = slackPlugin.messaging?.resolveOutboundSessionRoute;
    if (!resolveRoute) {
      throw new Error("slack messaging.resolveOutboundSessionRoute unavailable");
    }

    const route = await resolveRoute({
      cfg: {} as OpenClawConfig,
      agentId: "main",
      target: "channel:C1",
      currentSessionKey: "agent:main:slack:channel:C1:thread:1712345678.123456",
    });

    expectRecordFields(route, "Slack route", {
      sessionKey: "agent:main:slack:channel:c1:thread:1712345678.123456",
      baseSessionKey: "agent:main:slack:channel:c1",
      threadId: "1712345678.123456",
    });
  });

  it("canonicalizes bare Slack IM channel targets to direct user session routes", async () => {
    const resolveRoute = slackPlugin.messaging?.resolveOutboundSessionRoute;
    if (!resolveRoute) {
      throw new Error("slack messaging.resolveOutboundSessionRoute unavailable");
    }
    conversationsOpenMock.mockResolvedValueOnce({
      channel: {
        id: "D0AEWSDHAQH",
        is_im: true,
        user: "U09G2DJ0275",
      },
    });

    const route = await resolveRoute({
      cfg: {
        session: { dmScope: "per-channel-peer" },
        channels: {
          slack: {
            botToken: "xoxb-test",
            appToken: "xapp-test",
          },
        },
      } as OpenClawConfig,
      agentId: "main",
      target: "D0AEWSDHAQH",
      threadId: "1778110574.653649",
    });

    expect(conversationsOpenMock).toHaveBeenCalledWith({
      channel: "D0AEWSDHAQH",
      prevent_creation: true,
      return_im: true,
    });
    expectRecordFields(route, "Slack direct route", {
      sessionKey: "agent:main:slack:direct:u09g2dj0275:thread:1778110574.653649",
      baseSessionKey: "agent:main:slack:direct:u09g2dj0275",
      chatType: "direct",
      from: "slack:U09G2DJ0275",
      to: "user:U09G2DJ0275",
      threadId: "1778110574.653649",
    });
    expectRecordFields(requireRecord(route?.peer, "Slack direct peer"), "Slack direct peer", {
      kind: "direct",
      id: "U09G2DJ0275",
    });
  });

  it("canonicalizes explicit channel-prefixed Slack IM targets for mirror routing", async () => {
    const resolveRoute = slackPlugin.messaging?.resolveOutboundSessionRoute;
    if (!resolveRoute) {
      throw new Error("slack messaging.resolveOutboundSessionRoute unavailable");
    }
    conversationsOpenMock.mockResolvedValueOnce({
      channel: {
        id: "D123",
        is_im: true,
        user: "U123",
      },
    });

    const route = await resolveRoute({
      cfg: {
        session: { dmScope: "per-channel-peer" },
        channels: {
          slack: {
            botToken: "xoxb-test",
            appToken: "xapp-test",
          },
        },
      } as OpenClawConfig,
      agentId: "main",
      target: "channel:D123",
    });

    expectRecordFields(route, "Slack explicit IM route", {
      sessionKey: "agent:main:slack:direct:u123",
    });
    expectRecordFields(
      requireRecord(route?.peer, "Slack explicit IM peer"),
      "Slack explicit IM peer",
      {
        kind: "direct",
        id: "U123",
      },
    );
  });

  it("skips mirror routing for unresolved Slack IM channel targets", async () => {
    const resolveRoute = slackPlugin.messaging?.resolveOutboundSessionRoute;
    if (!resolveRoute) {
      throw new Error("slack messaging.resolveOutboundSessionRoute unavailable");
    }
    conversationsOpenMock.mockResolvedValueOnce({ channel: { id: "D0NOUSER001", is_im: true } });

    await expect(
      resolveRoute({
        cfg: {} as OpenClawConfig,
        agentId: "main",
        target: "D0NOUSER001",
        threadId: "1778110574.653649",
      }),
    ).resolves.toBeNull();
  });

  it("keeps Slack MPIM outbound routing as group", async () => {
    const resolveRoute = slackPlugin.messaging?.resolveOutboundSessionRoute;
    if (!resolveRoute) {
      throw new Error("slack messaging.resolveOutboundSessionRoute unavailable");
    }
    conversationsInfoMock.mockResolvedValueOnce({ channel: { id: "G123", is_mpim: true } });

    const route = await resolveRoute({
      cfg: { channels: { slack: { botToken: "xoxb-test" } } } as OpenClawConfig,
      agentId: "main",
      target: "G123",
    });

    expectRecordFields(route, "Slack MPIM route", {
      sessionKey: "agent:main:slack:group:g123",
      chatType: "channel",
      from: "slack:group:G123",
      to: "channel:G123",
    });
    expectRecordFields(requireRecord(route?.peer, "Slack MPIM peer"), "Slack MPIM peer", {
      kind: "group",
      id: "G123",
    });
  });
});

describe("slackPlugin security", () => {
  it("normalizes dm allowlist entries with trimmed prefixes", () => {
    const resolveDmPolicy = slackPlugin.security?.resolveDmPolicy;
    if (!resolveDmPolicy) {
      throw new Error("resolveDmPolicy unavailable");
    }

    const result = resolveDmPolicy({
      cfg: {
        channels: {
          slack: {
            dm: { policy: "allowlist", allowFrom: ["  slack:U123  "] },
          },
        },
      } as OpenClawConfig,
      account: slackPlugin.config.resolveAccount(
        {
          channels: {
            slack: {
              botToken: "xoxb-test",
              appToken: "xapp-test",
              dm: { policy: "allowlist", allowFrom: ["  slack:U123  "] },
            },
          },
        } as OpenClawConfig,
        "default",
      ),
    });
    if (!result) {
      throw new Error("slack resolveDmPolicy returned null");
    }

    expect(result.policy).toBe("allowlist");
    expect(result.allowFrom).toEqual(["  slack:U123  "]);
    expect(result.policyPath).toBe("channels.slack.dmPolicy");
    expect(result.allowFromPath).toBe("channels.slack.");
    expect(result.normalizeEntry?.("  slack:U123  ")).toBe("U123");
    expect(result.normalizeEntry?.("  user:U999  ")).toBe("U999");
  });
});

describe("slackPlugin outbound", () => {
  const cfg = {
    channels: {
      slack: {
        botToken: "xoxb-test",
        appToken: "xapp-test",
      },
    },
  };

  it("treats ACP block text as visible delivered output", () => {
    expect(
      slackPlugin.outbound?.shouldTreatDeliveredTextAsVisible?.({
        kind: "block",
        text: "hello",
      }),
    ).toBe(true);
    expect(
      slackPlugin.outbound?.shouldTreatDeliveredTextAsVisible?.({
        kind: "tool",
        text: "hello",
      }),
    ).toBe(false);
  });

  it("advertises the 8000-character Slack default chunk limit", () => {
    expect(slackOutbound.textChunkLimit).toBe(8000);
    expect(slackPlugin.outbound?.textChunkLimit).toBe(8000);
  });

  it("uses threadId as threadTs fallback for sendText", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-text" });
    const sendText = requireSlackSendText();

    const result = await sendText({
      cfg,
      to: "C123",
      text: "hello",
      accountId: "default",
      threadId: "1712345678.123456",
      deps: { sendSlack },
    });

    expect(sendSlack.mock.calls[0]?.[0]).toBe("C123");
    expect(sendSlack.mock.calls[0]?.[1]).toBe("hello");
    expect(requireMockCallArg(sendSlack, 0, 2).threadTs).toBe("1712345678.123456");
    expect(result).toEqual({ channel: "slack", messageId: "m-text" });
  });

  it("prefers replyToId over threadId for sendMedia", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-media" });
    const sendMedia = requireSlackSendMedia();

    const result = await sendMedia({
      cfg,
      to: "C999",
      text: "caption",
      mediaUrl: "https://example.com/image.png",
      accountId: "default",
      replyToId: "1712000000.000001",
      threadId: "1712345678.123456",
      deps: { sendSlack },
    });

    expect(sendSlack.mock.calls[0]?.[0]).toBe("C999");
    expect(sendSlack.mock.calls[0]?.[1]).toBe("caption");
    expectRecordFields(requireMockCallArg(sendSlack, 0, 2), "send options", {
      mediaUrl: "https://example.com/image.png",
      threadTs: "1712000000.000001",
    });
    expect(result).toEqual({ channel: "slack", messageId: "m-media" });
  });

  it("falls back to threadId when replyToId is not a Slack thread timestamp", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-text" });
    const sendText = requireSlackSendText();

    const result = await sendText({
      cfg,
      to: "C123",
      text: "hello",
      accountId: "default",
      replyToId: "msg-internal-1",
      threadId: "1712345678.123456",
      deps: { sendSlack },
    });

    expect(sendSlack.mock.calls[0]?.[0]).toBe("C123");
    expect(sendSlack.mock.calls[0]?.[1]).toBe("hello");
    expect(requireMockCallArg(sendSlack, 0, 2).threadTs).toBe("1712345678.123456");
    expect(result).toEqual({ channel: "slack", messageId: "m-text" });
  });

  it("does not stringify numeric Slack thread ids", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-text" });
    const sendText = requireSlackSendText();

    await sendText({
      cfg,
      to: "C123",
      text: "hello",
      accountId: "default",
      threadId: 1712345678.123456,
      deps: { sendSlack },
    });

    expect(sendSlack.mock.calls[0]?.[0]).toBe("C123");
    expect(sendSlack.mock.calls[0]?.[1]).toBe("hello");
    expect(requireMockCallArg(sendSlack, 0, 2).threadTs).toBeUndefined();
  });

  it("falls back to auto-thread lookup when replyToId is not a Slack thread timestamp", () => {
    const resolveAutoThreadId = slackPlugin.threading?.resolveAutoThreadId;
    if (!resolveAutoThreadId) {
      throw new Error("slack threading.resolveAutoThreadId unavailable");
    }

    const threadId = resolveAutoThreadId({
      cfg,
      to: "channel:C123",
      replyToId: "msg-internal-1",
      toolContext: {
        currentChannelId: "C123",
        currentThreadTs: "1712345678.123456",
        replyToMode: "all",
      },
    });

    expect(threadId).toBe("1712345678.123456");
  });

  it("does not recover invalid Slack auto-thread anchors", () => {
    const resolveAutoThreadId = slackPlugin.threading?.resolveAutoThreadId;
    if (!resolveAutoThreadId) {
      throw new Error("slack threading.resolveAutoThreadId unavailable");
    }

    const threadId = resolveAutoThreadId({
      cfg,
      to: "channel:C123",
      replyToId: "msg-internal-1",
      toolContext: {
        currentChannelId: "C123",
        currentThreadTs: "thread-root",
        replyToMode: "all",
      },
    });

    expect(threadId).toBeUndefined();
  });

  it("does not stringify numeric thread ids in tool context", () => {
    const buildToolContext = slackPlugin.threading?.buildToolContext;
    if (!buildToolContext) {
      throw new Error("slack threading.buildToolContext unavailable");
    }

    const context = buildToolContext({
      cfg,
      context: {
        To: "channel:C123",
        MessageThreadId: 1712345678.123456,
      },
    });

    expect(context?.currentThreadTs).toBeUndefined();
  });

  it("falls back to threadId in reply transport when replyToId is not a Slack thread timestamp", () => {
    const resolveReplyTransport = slackPlugin.threading?.resolveReplyTransport;
    if (!resolveReplyTransport) {
      throw new Error("slack threading.resolveReplyTransport unavailable");
    }

    expect(
      resolveReplyTransport({
        cfg,
        replyToId: "msg-internal-1",
        threadId: "1712345678.123456",
      }),
    ).toEqual({
      replyToId: "1712345678.123456",
      threadId: null,
    });
  });

  it("forwards mediaLocalRoots for sendMedia", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-media-local" });
    const sendMedia = requireSlackSendMedia();
    const mediaLocalRoots = ["/tmp/workspace"];

    const result = await sendMedia({
      cfg,
      to: "C999",
      text: "caption",
      mediaUrl: "/tmp/workspace/image.png",
      mediaLocalRoots,
      accountId: "default",
      deps: { sendSlack },
    });

    expect(sendSlack.mock.calls[0]?.[0]).toBe("C999");
    expect(sendSlack.mock.calls[0]?.[1]).toBe("caption");
    expectRecordFields(requireMockCallArg(sendSlack, 0, 2), "send options", {
      mediaUrl: "/tmp/workspace/image.png",
      mediaLocalRoots,
    });
    expect(result).toEqual({ channel: "slack", messageId: "m-media-local" });
  });

  it("normalizes slack button directives for direct outbound delivery", () => {
    const normalized = slackPlugin.outbound?.normalizePayload?.({
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-test",
            appToken: "xapp-test",
            capabilities: { interactiveReplies: true },
          },
        },
      },
      accountId: "default",
      payload: {
        text: "Slack interactive minimal test\n[[slack_buttons: Test:test-value]]",
      },
    });

    expect(normalized).toEqual({
      text: "Slack interactive minimal test",
      interactive: {
        blocks: [
          {
            type: "text",
            text: "Slack interactive minimal test",
          },
          {
            type: "buttons",
            buttons: [{ label: "Test", value: "test-value" }],
          },
        ],
      },
    });
  });

  it("sends block payload media first, then the final block message", async () => {
    const sendSlack = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "m-media-1" })
      .mockResolvedValueOnce({ messageId: "m-media-2" })
      .mockResolvedValueOnce({ messageId: "m-final" });
    const sendPayload = requireSlackSendPayload();

    const result = await sendPayload({
      cfg,
      to: "C999",
      text: "",
      payload: {
        text: "hello",
        mediaUrls: ["https://example.com/1.png", "https://example.com/2.png"],
        presentation: {
          blocks: [{ type: "text", text: "Block body" }],
        },
      },
      accountId: "default",
      deps: { sendSlack },
      mediaLocalRoots: ["/tmp/media"],
    });

    expect(sendSlack).toHaveBeenCalledTimes(3);
    expect(sendSlack.mock.calls[0]?.[0]).toBe("C999");
    expect(sendSlack.mock.calls[0]?.[1]).toBe("");
    expectRecordFields(requireMockCallArg(sendSlack, 0, 2), "first media options", {
      mediaUrl: "https://example.com/1.png",
      mediaLocalRoots: ["/tmp/media"],
    });
    expect(sendSlack.mock.calls[1]?.[0]).toBe("C999");
    expect(sendSlack.mock.calls[1]?.[1]).toBe("");
    expectRecordFields(requireMockCallArg(sendSlack, 1, 2), "second media options", {
      mediaUrl: "https://example.com/2.png",
      mediaLocalRoots: ["/tmp/media"],
    });
    expect(sendSlack.mock.calls[2]?.[0]).toBe("C999");
    expect(sendSlack.mock.calls[2]?.[1]).toBe("hello");
    expect(requireMockCallArg(sendSlack, 2, 2).blocks).toEqual([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Block body",
        },
      },
    ]);
    expect(result).toEqual({ channel: "slack", messageId: "m-final" });
  });

  it("renders shared interactive payloads into Slack Block Kit via plugin outbound", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-interactive" });
    const sendPayload = requireSlackSendPayload();

    const result = await sendPayload({
      cfg,
      to: "user:U123",
      text: "",
      payload: {
        text: "Slack interactive smoke.",
        interactive: {
          blocks: [
            {
              type: "text",
              text: "Slack interactive smoke.",
            },
            {
              type: "buttons",
              buttons: [
                { label: "Approve", value: "approve" },
                { label: "Reject", value: "reject" },
              ],
            },
            {
              type: "select",
              placeholder: "Choose a target",
              options: [
                { label: "Canary", value: "canary" },
                { label: "Production", value: "production" },
              ],
            },
          ],
        },
      },
      accountId: "default",
      deps: { sendSlack },
    });

    expect(sendSlack.mock.calls[0]?.[0]).toBe("user:U123");
    expect(sendSlack.mock.calls[0]?.[1]).toBe("Slack interactive smoke.");
    const blocks = requireArray(requireMockCallArg(sendSlack, 0, 2).blocks, "Slack blocks");
    expectRecordFields(blocks[0], "text block", { type: "section" });
    expectRecordFields(blocks[1], "button actions block", { type: "actions" });
    const buttons = requireArray(
      requireRecord(blocks[1], "button actions block").elements,
      "button elements",
    );
    expectRecordFields(buttons[0], "approve button", { type: "button", value: "approve" });
    expectRecordFields(buttons[1], "reject button", { type: "button", value: "reject" });
    expectRecordFields(blocks[2], "select actions block", { type: "actions" });
    const selectElements = requireArray(
      requireRecord(blocks[2], "select actions block").elements,
      "select elements",
    );
    const select = requireRecord(selectElements[0], "select element");
    expect(select.type).toBe("static_select");
    const options = requireArray(select.options, "select options");
    expectRecordFields(options[0], "canary option", { value: "canary" });
    expectRecordFields(options[1], "production option", { value: "production" });
    expect(result).toEqual({ channel: "slack", messageId: "m-interactive" });
  });
});

describe("slackPlugin directory", () => {
  it("lists configured peers without throwing a ReferenceError", async () => {
    const listPeers = requireSlackListPeers();

    await expect(
      listPeers({
        cfg: {
          channels: {
            slack: {
              dms: {
                U123: {},
              },
            },
          },
        },
        runtime: createRuntimeEnv(),
      }),
    ).resolves.toEqual([{ id: "user:u123", kind: "user" }]);
  });
});

describe("slackPlugin agentPrompt", () => {
  it("tells agents interactive replies are disabled by default", () => {
    const hints = slackPlugin.agentPrompt?.messageToolHints?.({
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-test",
            appToken: "xapp-test",
          },
        },
      },
    });

    expect(hints).toContain(
      "- Slack interactive replies are disabled. If needed, ask to set `channels.slack.capabilities.interactiveReplies=true` (or the same under `channels.slack.accounts.<account>.capabilities`).",
    );
    expect(hints).toContain(
      "- Slack plain text sends: write standard Markdown; OpenClaw converts it to Slack mrkdwn, including `**bold**`, headings, lists, and `[label](url)` links.",
    );
    expect(hints).toContain(
      "- Slack Block Kit or presentation text fields are sent as Slack mrkdwn directly; use `*bold*`, `_italic_`, `~strike~`, `<url|label>` links, and avoid Markdown headings or pipe tables there.",
    );
  });

  it("shows Slack interactive reply directives when enabled", () => {
    const hints = slackPlugin.agentPrompt?.messageToolHints?.({
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-test",
            appToken: "xapp-test",
            capabilities: { interactiveReplies: true },
          },
        },
      },
    });

    expect(hints).toContain(
      "- Prefer Slack buttons/selects for 2-5 discrete choices or parameter picks instead of asking the user to type one.",
    );
    expect(hints).toContain(
      "- Slack interactive replies: use `[[slack_buttons: Label:value, Other:other]]` to add action buttons that route clicks back as Slack interaction system events.",
    );
    expect(hints).toContain(
      "- Slack selects: use `[[slack_select: Placeholder | Label:value, Other:other]]` to add a static select menu that routes the chosen value back as a Slack interaction system event.",
    );
    expect(hints).toContain(
      "- Slack plain text sends: write standard Markdown; OpenClaw converts it to Slack mrkdwn, including `**bold**`, headings, lists, and `[label](url)` links.",
    );
    expect(hints).toContain(
      "- Slack Block Kit or presentation text fields are sent as Slack mrkdwn directly; use `*bold*`, `_italic_`, `~strike~`, `<url|label>` links, and avoid Markdown headings or pipe tables there.",
    );
  });
});

describe("slackPlugin outbound new targets", () => {
  const cfg = {
    channels: {
      slack: {
        botToken: "xoxb-test",
        appToken: "xapp-test",
      },
    },
  };

  it("sends to a new user target via DM without erroring", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-new-user", channelId: "D999" });
    const sendText = requireSlackSendText();

    const result = await sendText({
      cfg,
      to: "user:U99NEW",
      text: "hello new user",
      accountId: "default",
      deps: { sendSlack },
    });

    expect(sendSlack.mock.calls[0]?.[0]).toBe("user:U99NEW");
    expect(sendSlack.mock.calls[0]?.[1]).toBe("hello new user");
    expect(requireMockCallArg(sendSlack, 0, 2).cfg).toBe(cfg);
    expect(result).toEqual({ channel: "slack", messageId: "m-new-user", channelId: "D999" });
  });

  it("sends to a new channel target without erroring", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-new-chan", channelId: "C555" });
    const sendText = requireSlackSendText();

    const result = await sendText({
      cfg,
      to: "channel:C555NEW",
      text: "hello channel",
      accountId: "default",
      deps: { sendSlack },
    });

    expect(sendSlack.mock.calls[0]?.[0]).toBe("channel:C555NEW");
    expect(sendSlack.mock.calls[0]?.[1]).toBe("hello channel");
    expect(requireMockCallArg(sendSlack, 0, 2).cfg).toBe(cfg);
    expect(result).toEqual({ channel: "slack", messageId: "m-new-chan", channelId: "C555" });
  });

  it("sends media to a new user target without erroring", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-new-media", channelId: "D888" });
    const sendMedia = requireSlackSendMedia();

    const result = await sendMedia({
      cfg,
      to: "user:U88NEW",
      text: "here is a file",
      mediaUrl: "https://example.com/file.png",
      accountId: "default",
      deps: { sendSlack },
    });

    expect(sendSlack.mock.calls[0]?.[0]).toBe("user:U88NEW");
    expect(sendSlack.mock.calls[0]?.[1]).toBe("here is a file");
    expectRecordFields(requireMockCallArg(sendSlack, 0, 2), "send options", {
      cfg,
      mediaUrl: "https://example.com/file.png",
    });
    expect(result).toEqual({ channel: "slack", messageId: "m-new-media", channelId: "D888" });
  });
});

describe("slackPlugin configured bindings", () => {
  function requireSlackBindings() {
    const bindings = slackPlugin.bindings;
    if (!bindings) {
      throw new Error("slack bindings adapter unavailable");
    }
    return bindings;
  }

  it("normalizes Slack channel and user ids for configured ACP bindings", () => {
    const bindings = requireSlackBindings();

    expect(
      bindings.compileConfiguredBinding({
        binding: {} as never,
        conversationId: "channel:C123",
      }),
    ).toEqual({ conversationId: "c123" });
    expect(
      bindings.compileConfiguredBinding({
        binding: {} as never,
        conversationId: "#C123",
      }),
    ).toEqual({ conversationId: "c123" });
    expect(
      bindings.compileConfiguredBinding({
        binding: {} as never,
        conversationId: "<@U123>",
      }),
    ).toEqual({ conversationId: "u123" });
    expect(
      bindings.compileConfiguredBinding({
        binding: {} as never,
        conversationId: "slack:U123",
      }),
    ).toEqual({ conversationId: "u123" });
  });

  it("matches Slack thread replies against configured channel bindings", () => {
    const bindings = requireSlackBindings();
    const compiledBinding = bindings.compileConfiguredBinding({
      binding: {} as never,
      conversationId: "C123",
    });

    expect(compiledBinding).toEqual({ conversationId: "c123" });
    expect(
      bindings.matchInboundConversation({
        binding: {} as never,
        compiledBinding: compiledBinding!,
        conversationId: "1770408518.451689",
        parentConversationId: "C123",
      }),
    ).toEqual({
      conversationId: "c123",
      matchPriority: 1,
    });
  });
});

describe("slackPlugin config", () => {
  it("treats HTTP mode accounts with bot token + signing secret as configured", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          mode: "http",
          botToken: "xoxb-http",
          signingSecret: "secret-http", // pragma: allowlist secret
        },
      },
    };

    const { configured, snapshot } = await getSlackConfiguredState(cfg);

    expect(configured).toBe(true);
    expect(snapshot?.configured).toBe(true);
  });

  it("keeps socket mode requiring app token", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          mode: "socket",
          botToken: "xoxb-socket",
        },
      },
    };

    const { configured, snapshot } = await getSlackConfiguredState(cfg);

    expect(configured).toBe(false);
    expect(snapshot?.configured).toBe(false);
  });

  it("does not mark partial configured-unavailable token status as configured", async () => {
    const snapshot = await slackPlugin.status?.buildAccountSnapshot?.({
      account: {
        accountId: "default",
        name: "Default",
        enabled: true,
        configured: false,
        botTokenStatus: "configured_unavailable",
        appTokenStatus: "missing",
        botTokenSource: "config",
        appTokenSource: "none",
        config: {},
      } as never,
      cfg: {} as OpenClawConfig,
      runtime: undefined,
    });

    expect(snapshot?.configured).toBe(false);
    expect(snapshot?.botTokenStatus).toBe("configured_unavailable");
    expect(snapshot?.appTokenStatus).toBe("missing");
  });

  it("keeps HTTP mode signing-secret unavailable accounts configured in snapshots", async () => {
    const snapshot = await slackPlugin.status?.buildAccountSnapshot?.({
      account: {
        accountId: "default",
        name: "Default",
        enabled: true,
        configured: true,
        mode: "http",
        botTokenStatus: "available",
        signingSecretStatus: "configured_unavailable", // pragma: allowlist secret
        botTokenSource: "config",
        signingSecretSource: "config", // pragma: allowlist secret
        config: {
          mode: "http",
          botToken: "xoxb-http",
          signingSecret: { source: "env", provider: "default", id: "SLACK_SIGNING_SECRET" },
        },
      } as never,
      cfg: {} as OpenClawConfig,
      runtime: undefined,
    });

    expect(snapshot?.configured).toBe(true);
    expect(snapshot?.botTokenStatus).toBe("available");
    expect(snapshot?.signingSecretStatus).toBe("configured_unavailable");
  });
});
