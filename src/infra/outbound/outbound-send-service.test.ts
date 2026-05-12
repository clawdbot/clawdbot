import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";

const getDefaultMediaLocalRootsMock = vi.hoisted(() => vi.fn(() => []));
const dispatchChannelMessageActionMock = vi.hoisted(() => vi.fn());
const sendMessageMock = vi.hoisted(() => vi.fn());
const sendPollMock = vi.hoisted(() => vi.fn());
const getAgentScopedMediaLocalRootsForSourcesMock = vi.hoisted(() =>
  vi.fn<(params: { cfg: unknown; agentId?: string; mediaSources?: readonly string[] }) => string[]>(
    () => ["/tmp/agent-roots"],
  ),
);
const createAgentScopedHostMediaReadFileMock = vi.hoisted(() =>
  vi.fn<(params: { cfg: unknown; agentId?: string }) => (filePath: string) => Promise<Buffer>>(
    () => async () => Buffer.from("capability"),
  ),
);
const resolveAgentScopedOutboundMediaAccessMock = vi.hoisted(() =>
  vi.fn<
    (params: {
      cfg: unknown;
      agentId?: string;
      mediaSources?: readonly string[];
      accountId?: string;
      requesterSenderId?: string;
      requesterSenderName?: string;
      requesterSenderUsername?: string;
      requesterSenderE164?: string;
    }) => {
      localRoots: string[];
      readFile: (filePath: string) => Promise<Buffer>;
    }
  >((params) => ({
    localRoots: getAgentScopedMediaLocalRootsForSourcesMock({
      cfg: params.cfg,
      agentId: params.agentId,
      mediaSources: params.mediaSources ?? [],
    }),
    readFile: createAgentScopedHostMediaReadFileMock({
      cfg: params.cfg,
      agentId: params.agentId,
    }),
  })),
);
const appendAssistantMessageToSessionTranscriptMock = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, sessionFile: "x" })),
);

const mocks = {
  getDefaultMediaLocalRoots: getDefaultMediaLocalRootsMock,
  dispatchChannelMessageAction: dispatchChannelMessageActionMock,
  sendMessage: sendMessageMock,
  sendPoll: sendPollMock,
  getAgentScopedMediaLocalRootsForSources: getAgentScopedMediaLocalRootsForSourcesMock,
  createAgentScopedHostMediaReadFile: createAgentScopedHostMediaReadFileMock,
  resolveAgentScopedOutboundMediaAccess: resolveAgentScopedOutboundMediaAccessMock,
  appendAssistantMessageToSessionTranscript: appendAssistantMessageToSessionTranscriptMock,
};

vi.mock("../../channels/plugins/message-action-dispatch.js", () => ({
  dispatchChannelMessageAction: mocks.dispatchChannelMessageAction,
}));

vi.mock("./message.js", () => ({
  sendMessage: mocks.sendMessage,
  sendPoll: mocks.sendPoll,
}));

vi.mock("../../media/read-capability.js", () => ({
  createAgentScopedHostMediaReadFile: mocks.createAgentScopedHostMediaReadFile,
  resolveAgentScopedOutboundMediaAccess: mocks.resolveAgentScopedOutboundMediaAccess,
}));

vi.mock("../../media/local-roots.js", async () => {
  const actual = await vi.importActual<typeof import("../../media/local-roots.js")>(
    "../../media/local-roots.js",
  );
  return {
    ...actual,
    getDefaultMediaLocalRoots: mocks.getDefaultMediaLocalRoots,
    getAgentScopedMediaLocalRootsForSources: mocks.getAgentScopedMediaLocalRootsForSources,
  };
});

vi.mock("../../config/sessions.js", () => ({
  appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
}));

type OutboundSendServiceModule = typeof import("./outbound-send-service.js");
type ExecuteSendInput = Parameters<OutboundSendServiceModule["executeSendAction"]>[0];
type ExecuteSendContext = ExecuteSendInput["ctx"];

let executePollAction: OutboundSendServiceModule["executePollAction"];
let executeSendAction: OutboundSendServiceModule["executeSendAction"];

type MockCalls = {
  mock: { calls: unknown[][] };
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  expect(Array.isArray(value), label).toBe(true);
  return value as unknown[];
}

function expectFields(record: Record<string, unknown>, expected: Record<string, unknown>) {
  for (const [key, value] of Object.entries(expected)) {
    expect(record[key], key).toEqual(value);
  }
}

function expectSingleCallFirstArg(
  mock: MockCalls,
  label = "mock first argument",
): Record<string, unknown> {
  expect(mock.mock.calls).toHaveLength(1);
  const [firstArg] = mock.mock.calls[0] ?? [];
  return requireRecord(firstArg, label);
}

function expectSingleCallFields(
  mock: MockCalls,
  expected: Record<string, unknown>,
  label?: string,
): Record<string, unknown> {
  const firstArg = expectSingleCallFirstArg(mock, label);
  expectFields(firstArg, expected);
  return firstArg;
}

describe("executeSendAction", () => {
  function pluginActionResult(messageId: string) {
    return {
      ok: true,
      value: { messageId },
      continuePrompt: "",
      output: "",
      sessionId: "s1",
      model: "gpt-5.4",
      usage: {},
    };
  }

  function expectMirrorWrite(
    expected: Partial<{
      agentId: string;
      sessionKey: string;
      text: string;
      idempotencyKey: string;
      mediaUrls: string[];
    }>,
  ) {
    expectSingleCallFields(mocks.appendAssistantMessageToSessionTranscript, {
      ...expected,
      config: {},
    });
  }

  async function executePluginMirroredSend(params: {
    mirror?: Partial<{
      sessionKey: string;
      agentId?: string;
      idempotencyKey?: string;
    }>;
    mediaUrls?: string[];
  }) {
    mocks.dispatchChannelMessageAction.mockResolvedValue(pluginActionResult("msg-plugin"));

    await executeSendAction({
      ctx: {
        cfg: {},
        channel: "demo-outbound",
        params: { to: "channel:123", message: "hello" },
        dryRun: false,
        mirror: {
          sessionKey: "agent:main:demo-outbound:channel:123",
          ...params.mirror,
        },
      },
      to: "channel:123",
      message: "hello",
      mediaUrls: params.mediaUrls,
    });
  }

  function createPluginMediaSendContext(
    overrides: Partial<ExecuteSendContext>,
  ): ExecuteSendContext {
    return {
      cfg: {},
      channel: "demo-outbound",
      params: { media: "/tmp/host.png" },
      sessionKey: "agent:main:directchat:group:ops",
      dryRun: false,
      ...overrides,
    } as ExecuteSendContext;
  }

  async function executePluginMediaSend(ctx: Partial<ExecuteSendContext>) {
    mocks.dispatchChannelMessageAction.mockResolvedValue(pluginActionResult("msg-plugin"));

    await executeSendAction({
      ctx: createPluginMediaSendContext(ctx),
      to: "channel:123",
      message: "hello",
    });
  }

  beforeAll(async () => {
    ({ executePollAction, executeSendAction } = await import("./outbound-send-service.js"));
  });

  beforeEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    mocks.dispatchChannelMessageAction.mockClear();
    mocks.sendMessage.mockClear();
    mocks.sendPoll.mockClear();
    mocks.getDefaultMediaLocalRoots.mockClear();
    mocks.getAgentScopedMediaLocalRootsForSources.mockClear();
    mocks.createAgentScopedHostMediaReadFile.mockClear();
    mocks.resolveAgentScopedOutboundMediaAccess.mockClear();
    mocks.appendAssistantMessageToSessionTranscript.mockClear();
  });

  it("forwards ctx.agentId to sendMessage on core outbound path", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(null);
    mocks.sendMessage.mockResolvedValue({
      channel: "demo-outbound",
      to: "channel:123",
      via: "direct",
      mediaUrl: null,
    });

    await executeSendAction({
      ctx: {
        cfg: {},
        channel: "demo-outbound",
        params: {},
        agentId: "work",
        dryRun: false,
      },
      to: "channel:123",
      message: "hello",
    });

    expectSingleCallFields(mocks.sendMessage, {
      agentId: "work",
      channel: "demo-outbound",
      to: "channel:123",
      content: "hello",
    });
  });

  it("forwards requesterSenderId to sendMessage on core outbound path", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(null);
    mocks.sendMessage.mockResolvedValue({
      channel: "demo-outbound",
      to: "channel:123",
      via: "direct",
      mediaUrl: null,
    });

    await executeSendAction({
      ctx: {
        cfg: {},
        channel: "demo-outbound",
        params: {},
        sessionKey: "agent:main:directchat:group:ops",
        requesterSenderId: "attacker",
        dryRun: false,
      },
      to: "channel:123",
      message: "hello",
    });

    expectSingleCallFields(mocks.sendMessage, {
      requesterSenderId: "attacker",
    });
  });

  it("forwards non-id requester sender fields to sendMessage on core outbound path", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(null);
    mocks.sendMessage.mockResolvedValue({
      channel: "demo-outbound",
      to: "channel:123",
      via: "direct",
      mediaUrl: null,
    });

    await executeSendAction({
      ctx: {
        cfg: {},
        channel: "demo-outbound",
        params: {},
        sessionKey: "agent:main:directchat:group:ops",
        requesterSenderName: "Alice",
        requesterSenderUsername: "alice_u",
        requesterSenderE164: "+15551234567",
        dryRun: false,
      },
      to: "channel:123",
      message: "hello",
    });

    expectSingleCallFields(mocks.sendMessage, {
      requesterSenderName: "Alice",
      requesterSenderUsername: "alice_u",
      requesterSenderE164: "+15551234567",
    });
  });

  it("forwards requester session context to sendMessage on core outbound path", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(null);
    mocks.sendMessage.mockResolvedValue({
      channel: "demo-outbound",
      to: "channel:123",
      via: "direct",
      mediaUrl: null,
    });

    await executeSendAction({
      ctx: {
        cfg: {},
        channel: "demo-outbound",
        params: {},
        sessionKey: "agent:main:directchat:group:ops",
        requesterAccountId: "source-account",
        requesterSenderId: "attacker",
        accountId: "destination-account",
        dryRun: false,
      },
      to: "channel:123",
      message: "hello",
    });

    expectSingleCallFields(mocks.sendMessage, {
      requesterSessionKey: "agent:main:directchat:group:ops",
      requesterAccountId: "source-account",
      requesterSenderId: "attacker",
      accountId: "destination-account",
    });
  });

  it("forwards requesterSenderId into outbound media access resolution", async () => {
    await executePluginMediaSend({
      requesterSenderId: "attacker",
    });

    expectSingleCallFields(mocks.resolveAgentScopedOutboundMediaAccess, {
      requesterSenderId: "attacker",
    });
  });

  it("forwards non-id requester sender fields into outbound media access resolution", async () => {
    await executePluginMediaSend({
      requesterSenderName: "Alice",
      requesterSenderUsername: "alice_u",
      requesterSenderE164: "+15551234567",
    });

    expectSingleCallFields(mocks.resolveAgentScopedOutboundMediaAccess, {
      requesterSenderName: "Alice",
      requesterSenderUsername: "alice_u",
      requesterSenderE164: "+15551234567",
    });
  });

  it("keeps requester session channel authoritative for media policy", async () => {
    await executePluginMediaSend({
      requesterSenderId: "attacker",
    });

    expectSingleCallFields(mocks.resolveAgentScopedOutboundMediaAccess, {
      sessionKey: "agent:main:directchat:group:ops",
      messageProvider: undefined,
    });
  });

  it("uses requester account for media policy when session context is present", async () => {
    await executePluginMediaSend({
      requesterAccountId: "source-account",
      requesterSenderId: "attacker",
      accountId: "destination-account",
    });

    expectSingleCallFields(mocks.resolveAgentScopedOutboundMediaAccess, {
      sessionKey: "agent:main:directchat:group:ops",
      accountId: "source-account",
    });
  });

  it("falls back to destination account for media policy when requester account is missing", async () => {
    await executePluginMediaSend({
      requesterSenderId: "attacker",
      accountId: "destination-account",
    });

    expectSingleCallFields(mocks.resolveAgentScopedOutboundMediaAccess, {
      sessionKey: "agent:main:directchat:group:ops",
      accountId: "destination-account",
    });
  });

  it("falls back to destination account when forwarding requester context to sendMessage", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(null);
    mocks.sendMessage.mockResolvedValue({
      channel: "demo-outbound",
      to: "channel:123",
      via: "direct",
      mediaUrl: null,
    });

    await executeSendAction({
      ctx: {
        cfg: {},
        channel: "demo-outbound",
        params: {},
        sessionKey: "agent:main:directchat:group:ops",
        requesterSenderId: "attacker",
        accountId: "destination-account",
        dryRun: false,
      },
      to: "channel:123",
      message: "hello",
    });

    expectSingleCallFields(mocks.sendMessage, {
      requesterSessionKey: "agent:main:directchat:group:ops",
      requesterAccountId: "destination-account",
    });
  });

  it("uses plugin poll action when available", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(pluginActionResult("poll-plugin"));

    const result = await executePollAction({
      ctx: {
        cfg: {},
        channel: "demo-outbound",
        params: {},
        dryRun: false,
      },
      resolveCorePoll: () => ({
        to: "channel:123",
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
        maxSelections: 1,
      }),
    });

    expect(result.handledBy).toBe("plugin");
    expect(mocks.sendPoll).not.toHaveBeenCalled();
  });

  it("does not invoke shared poll parsing before plugin poll dispatch", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(pluginActionResult("poll-plugin"));
    const resolveCorePoll = vi.fn(() => {
      throw new Error("shared poll fallback should not run");
    });

    const result = await executePollAction({
      ctx: {
        cfg: {},
        channel: "demo-outbound",
        params: {
          pollQuestion: "Lunch?",
          pollOption: ["Pizza", "Sushi"],
          pollDurationSeconds: 90,
          pollPublic: true,
        },
        dryRun: false,
      },
      resolveCorePoll,
    });

    expect(result.handledBy).toBe("plugin");
    expect(resolveCorePoll).not.toHaveBeenCalled();
    expect(mocks.sendPoll).not.toHaveBeenCalled();
  });

  it("passes agent-scoped media local roots to plugin dispatch", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(pluginActionResult("msg-plugin"));

    await executeSendAction({
      ctx: {
        cfg: {},
        channel: "demo-outbound",
        params: { to: "channel:123", message: "hello" },
        agentId: "agent-1",
        dryRun: false,
      },
      to: "channel:123",
      message: "hello",
    });

    expect(mocks.getAgentScopedMediaLocalRootsForSources).toHaveBeenCalledWith({
      cfg: {},
      agentId: "agent-1",
      mediaSources: [],
    });
    expectSingleCallFields(mocks.dispatchChannelMessageAction, {
      mediaLocalRoots: ["/tmp/agent-roots"],
      mediaReadFile: mocks.createAgentScopedHostMediaReadFile.mock.results[0]?.value,
    });
  });

  it("passes concrete media sources when widening plugin dispatch roots", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(pluginActionResult("msg-plugin"));

    await executeSendAction({
      ctx: {
        cfg: {},
        channel: "demo-outbound",
        params: {
          to: "channel:123",
          message: "hello",
          media: "/Users/peter/Pictures/photo.png",
        },
        agentId: "agent-1",
        dryRun: false,
      },
      to: "channel:123",
      message: "hello",
      mediaUrl: "/Users/peter/Pictures/photo.png",
    });

    expect(mocks.getAgentScopedMediaLocalRootsForSources).toHaveBeenCalledWith({
      cfg: {},
      agentId: "agent-1",
      mediaSources: ["/Users/peter/Pictures/photo.png"],
    });
  });

  it("passes mirror idempotency keys through plugin-handled sends", async () => {
    await executePluginMirroredSend({
      mirror: {
        idempotencyKey: "idem-plugin-send-1",
      },
    });

    expectMirrorWrite({
      sessionKey: "agent:main:demo-outbound:channel:123",
      text: "hello",
      idempotencyKey: "idem-plugin-send-1",
    });
  });

  it("falls back to message and media params for plugin-handled mirror writes", async () => {
    await executePluginMirroredSend({
      mirror: {
        agentId: "agent-9",
      },
      mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
    });

    expectMirrorWrite({
      agentId: "agent-9",
      sessionKey: "agent:main:demo-outbound:channel:123",
      text: "hello",
      mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
    });
  });

  it("skips plugin dispatch during dry-run sends and forwards gateway + silent to sendMessage", async () => {
    mocks.sendMessage.mockResolvedValue({
      channel: "demo-outbound",
      to: "channel:123",
      via: "gateway",
      mediaUrl: null,
    });

    await executeSendAction({
      ctx: {
        cfg: {},
        channel: "demo-outbound",
        params: { to: "channel:123", message: "hello" },
        dryRun: true,
        silent: true,
        gateway: {
          url: "http://127.0.0.1:18789",
          token: "tok",
          timeoutMs: 5000,
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
      },
      to: "channel:123",
      message: "hello",
    });

    expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
    const sendArgs = expectSingleCallFields(mocks.sendMessage, {
      to: "channel:123",
      content: "hello",
      dryRun: true,
      silent: true,
    });
    expectFields(requireRecord(sendArgs.gateway, "send gateway"), {
      url: "http://127.0.0.1:18789",
      token: "tok",
      timeoutMs: 5000,
    });
  });

  it("routes prepared plugin send payloads through core best-effort delivery by default", async () => {
    const prepareSendPayload = vi.fn(({ payload }) => ({
      ...payload,
      channelData: { prepared: true },
    }));
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "discord" }),
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        prepareSendPayload,
        handleAction: async () => ({ content: [], details: { ok: true } }),
      },
      outbound: { deliveryMode: "direct" },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "discord", plugin, source: "test" }]));
    mocks.sendMessage.mockResolvedValue({
      channel: "discord",
      to: "channel:123",
      via: "direct",
      mediaUrl: null,
    });

    await executeSendAction({
      ctx: {
        cfg: {},
        channel: "discord",
        params: { to: "channel:123", message: "hello" },
        dryRun: false,
      },
      to: "channel:123",
      message: "hello",
    });

    expect(prepareSendPayload).toHaveBeenCalled();
    expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
    const sendArgs = expectSingleCallFields(mocks.sendMessage, {
      channel: "discord",
      queuePolicy: "best_effort",
    });
    const [payload] = requireArray(sendArgs.payloads, "send payloads");
    expectFields(requireRecord(payload, "prepared payload"), {
      channelData: { prepared: true },
    });
  });

  it("uses required core delivery only when the send action opts out of best-effort", async () => {
    const prepareSendPayload = vi.fn(({ payload }) => ({
      ...payload,
      channelData: { prepared: true },
    }));
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "discord" }),
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        prepareSendPayload,
        handleAction: async () => ({ content: [], details: { ok: true } }),
      },
      outbound: { deliveryMode: "direct" },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "discord", plugin, source: "test" }]));
    mocks.sendMessage.mockResolvedValue({
      channel: "discord",
      to: "channel:123",
      via: "direct",
      mediaUrl: null,
    });

    await executeSendAction({
      ctx: {
        cfg: {},
        channel: "discord",
        params: { to: "channel:123", message: "hello" },
        dryRun: false,
      },
      to: "channel:123",
      message: "hello",
      bestEffort: false,
    });

    expectSingleCallFields(mocks.sendMessage, {
      channel: "discord",
      queuePolicy: "required",
    });
  });

  it("forwards poll args to sendPoll on core outbound path", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(null);
    mocks.sendPoll.mockResolvedValue({
      channel: "demo-outbound",
      to: "channel:123",
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
      durationSeconds: null,
      durationHours: null,
      via: "gateway",
    });

    await executePollAction({
      ctx: {
        cfg: {},
        channel: "demo-outbound",
        params: {},
        accountId: "acc-1",
        dryRun: false,
      },
      resolveCorePoll: () => ({
        to: "channel:123",
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
        maxSelections: 1,
        durationSeconds: 300,
        threadId: "thread-1",
        isAnonymous: true,
      }),
    });

    expectSingleCallFields(mocks.sendPoll, {
      channel: "demo-outbound",
      accountId: "acc-1",
      to: "channel:123",
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
      durationSeconds: 300,
      threadId: "thread-1",
      isAnonymous: true,
    });
  });

  it("skips plugin dispatch during dry-run polls and forwards durationHours + silent", async () => {
    mocks.sendPoll.mockResolvedValue({
      channel: "demo-outbound",
      to: "channel:123",
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
      durationSeconds: null,
      durationHours: 6,
      via: "gateway",
    });

    await executePollAction({
      ctx: {
        cfg: {},
        channel: "demo-outbound",
        params: {},
        dryRun: true,
        silent: true,
        gateway: {
          url: "http://127.0.0.1:18789",
          token: "tok",
          timeoutMs: 5000,
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
      },
      resolveCorePoll: () => ({
        to: "channel:123",
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
        maxSelections: 1,
        durationHours: 6,
      }),
    });

    expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
    const pollArgs = expectSingleCallFields(mocks.sendPoll, {
      to: "channel:123",
      question: "Lunch?",
      durationHours: 6,
      dryRun: true,
      silent: true,
    });
    expectFields(requireRecord(pollArgs.gateway, "poll gateway"), {
      url: "http://127.0.0.1:18789",
      token: "tok",
      timeoutMs: 5000,
    });
  });
});
