import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn(),
  resolveOutboundTarget: vi.fn(),
  deliverOutboundPayloads: vi.fn(),
  resolveOutboundDurableFinalDeliverySupport: vi.fn(),
  resolveRuntimePluginRegistry: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  normalizeChannelId: (channel?: string) => channel?.trim().toLowerCase() ?? undefined,
  getLoadedChannelPlugin: mocks.getChannelPlugin,
  getChannelPlugin: mocks.getChannelPlugin,
  listChannelPlugins: () => [],
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: () => "main",
  resolveSessionAgentId: ({
    sessionKey,
  }: {
    sessionKey?: string;
    config?: unknown;
    agentId?: string;
  }) => {
    const match = sessionKey?.match(/^agent:([^:]+)/i);
    return match?.[1] ?? "main";
  },
  resolveAgentWorkspaceDir: () => "/tmp/openclaw-test-workspace",
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: ({ config }: { config: unknown }) => ({ config, changes: [] }),
}));

vi.mock("../../plugins/loader.js", () => ({
  resolveRuntimePluginRegistry: mocks.resolveRuntimePluginRegistry,
}));

vi.mock("./targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
}));

vi.mock("./deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
  resolveOutboundDurableFinalDeliverySupport: mocks.resolveOutboundDurableFinalDeliverySupport,
}));

vi.mock("../../utils/message-channel.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils/message-channel.js")>(
    "../../utils/message-channel.js",
  );
  const deliverable = ["forum", "directchat"];
  return {
    ...actual,
    listDeliverableMessageChannels: () => deliverable,
    isDeliverableMessageChannel: (channel: string) => deliverable.includes(channel),
    isGatewayMessageChannel: (channel: string) =>
      [...deliverable, actual.INTERNAL_MESSAGE_CHANNEL].includes(channel),
    normalizeMessageChannel: (value?: string | null) => value?.trim().toLowerCase() || undefined,
  };
});

import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

let sendMessage: typeof import("./message.js").sendMessage;
let resetOutboundChannelResolutionStateForTest: typeof import("./channel-resolution.js").resetOutboundChannelResolutionStateForTest;

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(
  value: unknown,
  expected: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(expectedValue);
  }
  return record;
}

function getMockCallArg(
  mock: { mock: { calls: readonly unknown[][] } },
  callIndex: number,
  argIndex: number,
  label: string,
): unknown {
  const call = (mock.mock.calls as unknown[][])[callIndex];
  if (!call) {
    throw new Error(`expected ${label} call ${callIndex}`);
  }
  return call[argIndex];
}

function expectDeliveryCallFields(expected: Record<string, unknown>): Record<string, unknown> {
  return expectRecordFields(
    getMockCallArg(mocks.deliverOutboundPayloads, 0, 0, "outbound delivery"),
    expected,
    "outbound delivery params",
  );
}

describe("sendMessage", () => {
  beforeAll(async () => {
    ({ sendMessage } = await import("./message.js"));
    ({ resetOutboundChannelResolutionStateForTest } = await import("./channel-resolution.js"));
  });

  beforeEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    resetOutboundChannelResolutionStateForTest();
    mocks.getChannelPlugin.mockClear();
    mocks.resolveOutboundTarget.mockClear();
    mocks.deliverOutboundPayloads.mockClear();
    mocks.resolveOutboundDurableFinalDeliverySupport.mockClear();
    mocks.resolveRuntimePluginRegistry.mockClear();

    mocks.getChannelPlugin.mockReturnValue({
      outbound: { deliveryMode: "direct" },
    });
    mocks.resolveOutboundTarget.mockImplementation(({ to }: { to: string }) => ({ ok: true, to }));
    mocks.deliverOutboundPayloads.mockResolvedValue([{ channel: "forum", messageId: "m1" }]);
    mocks.resolveOutboundDurableFinalDeliverySupport.mockResolvedValue({ ok: true });
  });

  it("passes explicit agentId to outbound delivery for scoped media roots", async () => {
    await sendMessage({
      cfg: {},
      channel: "forum",
      to: "123456",
      content: "hi",
      agentId: "work",
    });

    const deliveryParams = expectDeliveryCallFields({ channel: "forum", to: "123456" });
    expectRecordFields(deliveryParams.session, { agentId: "work" }, "outbound session");
  });

  it("forwards requesterSenderId into the outbound delivery session", async () => {
    await sendMessage({
      cfg: {},
      channel: "forum",
      to: "123456",
      content: "hi",
      requesterSenderId: "attacker",
      mirror: {
        sessionKey: "agent:main:forum:group:ops",
      },
    });

    expectRecordFields(
      expectDeliveryCallFields({}).session,
      {
        key: "agent:main:forum:group:ops",
        requesterSenderId: "attacker",
      },
      "outbound session",
    );
  });

  it("forwards non-id requester sender fields into the outbound delivery session", async () => {
    await sendMessage({
      cfg: {},
      channel: "forum",
      to: "123456",
      content: "hi",
      requesterSenderName: "Alice",
      requesterSenderUsername: "alice_u",
      requesterSenderE164: "+15551234567",
      mirror: {
        sessionKey: "agent:main:forum:group:ops",
      },
    });

    expectRecordFields(
      expectDeliveryCallFields({}).session,
      {
        key: "agent:main:forum:group:ops",
        requesterSenderName: "Alice",
        requesterSenderUsername: "alice_u",
        requesterSenderE164: "+15551234567",
      },
      "outbound session",
    );
  });

  it("uses requester session/account for outbound delivery policy context", async () => {
    await sendMessage({
      cfg: {},
      channel: "forum",
      to: "123456",
      content: "hi",
      requesterSessionKey: "agent:main:directchat:group:ops",
      requesterAccountId: "work",
      requesterSenderId: "attacker",
      mirror: {
        sessionKey: "agent:main:forum:dm:123456",
      },
    });

    const deliveryParams = expectDeliveryCallFields({});
    expectRecordFields(
      deliveryParams.session,
      {
        key: "agent:main:directchat:group:ops",
        requesterAccountId: "work",
        requesterSenderId: "attacker",
      },
      "outbound session",
    );
    expectRecordFields(
      deliveryParams.mirror,
      { sessionKey: "agent:main:forum:dm:123456" },
      "outbound mirror",
    );
  });

  it("propagates the send idempotency key into mirrored transcript delivery", async () => {
    await sendMessage({
      cfg: {},
      channel: "forum",
      to: "123456",
      content: "hi",
      idempotencyKey: "idem-send-1",
      mirror: {
        sessionKey: "agent:main:forum:dm:123456",
      },
    });

    expectRecordFields(
      expectDeliveryCallFields({}).mirror,
      {
        sessionKey: "agent:main:forum:dm:123456",
        text: "hi",
        idempotencyKey: "idem-send-1",
      },
      "outbound mirror",
    );
  });

  it("maps voice media sends onto outbound audioAsVoice payloads", async () => {
    await sendMessage({
      cfg: {},
      channel: "forum",
      to: "123456",
      content: "voice note",
      mediaUrl: "file:///tmp/openclaw-voice.ogg",
      asVoice: true,
    });

    expectRecordFields(
      (expectDeliveryCallFields({}).payloads as unknown[] | undefined)?.[0],
      {
        text: "voice note",
        mediaUrl: "file:///tmp/openclaw-voice.ogg",
        audioAsVoice: true,
      },
      "voice payload",
    );
  });

  it("forwards prepared payloads and required queue policy into outbound delivery", async () => {
    const mediaAccess = {
      localRoots: ["/tmp/media"],
      readFile: vi.fn(async () => Buffer.from("media")),
    };

    await sendMessage({
      cfg: {},
      channel: "forum",
      to: "123456",
      content: "fallback text",
      payloads: [{ text: "prepared", channelData: { forum: { card: true } } }],
      queuePolicy: "required",
      mediaAccess,
    });

    const deliveryParams = expectDeliveryCallFields({
      queuePolicy: "required",
      mediaAccess,
    });
    expectRecordFields(
      (deliveryParams.payloads as unknown[] | undefined)?.[0],
      {
        text: "prepared",
        channelData: { forum: { card: true } },
      },
      "prepared payload",
    );
    const supportParams = expectRecordFields(
      getMockCallArg(
        mocks.resolveOutboundDurableFinalDeliverySupport,
        0,
        0,
        "durable delivery support",
      ),
      { channel: "forum" },
      "durable delivery support params",
    );
    expectRecordFields(
      supportParams.requirements,
      {
        payload: true,
        reconcileUnknownSend: true,
      },
      "durable delivery requirements",
    );
  });

  it("rejects required durable sends before enqueue when replay safety is unsupported", async () => {
    mocks.resolveOutboundDurableFinalDeliverySupport.mockResolvedValueOnce({
      ok: false,
      reason: "capability_mismatch",
      capability: "reconcileUnknownSend",
    });

    await expect(
      sendMessage({
        cfg: {},
        channel: "forum",
        to: "123456",
        content: "fallback text",
        payloads: [{ text: "prepared", channelData: { forum: { card: true } } }],
        queuePolicy: "required",
      }),
    ).rejects.toThrow("missing reconcileUnknownSend");

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("applies mirror matrix semantics for MEDIA and silent token variants", async () => {
    const matrix: Array<{
      name: string;
      content: string;
      mediaUrl?: string;
      expectedPayloads: Array<{
        text: string;
        mediaUrl: string | null;
        mediaUrls: string[];
      }>;
      expectedMirror: {
        text: string;
        mediaUrls?: string[];
      };
    }> = [
      {
        name: "MEDIA directives",
        content: "Here\nMEDIA:https://example.com/a.png\nMEDIA:https://example.com/b.png",
        expectedPayloads: [
          {
            text: "Here",
            mediaUrl: null,
            mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
          },
        ],
        expectedMirror: {
          text: "Here",
          mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
        },
      },
      {
        name: "exact NO_REPLY",
        content: "NO_REPLY",
        expectedPayloads: [],
        expectedMirror: {
          text: "NO_REPLY",
          mediaUrls: undefined,
        },
      },
      {
        name: "JSON NO_REPLY",
        content: '{\n  "action": "NO_REPLY"\n}',
        expectedPayloads: [],
        expectedMirror: {
          text: '{\n  "action": "NO_REPLY"\n}',
          mediaUrls: undefined,
        },
      },
      {
        name: "exact NO_REPLY with explicit media",
        content: "NO_REPLY",
        mediaUrl: "https://example.com/c.png",
        expectedPayloads: [
          {
            text: "",
            mediaUrl: "https://example.com/c.png",
            mediaUrls: ["https://example.com/c.png"],
          },
        ],
        expectedMirror: {
          text: "NO_REPLY",
          mediaUrls: ["https://example.com/c.png"],
        },
      },
    ];

    for (const entry of matrix) {
      mocks.deliverOutboundPayloads.mockClear();

      await sendMessage({
        cfg: {},
        channel: "forum",
        to: "123456",
        content: entry.content,
        ...(entry.mediaUrl ? { mediaUrl: entry.mediaUrl } : {}),
        mirror: {
          sessionKey: "agent:main:forum:dm:123456",
        },
      });

      expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
      const deliveryCall = mocks.deliverOutboundPayloads.mock.calls[0]?.[0] as
        | {
            payloads?: Array<{ text?: string; mediaUrl?: string; mediaUrls?: string[] }>;
            mirror?: unknown;
          }
        | undefined;
      const payloadSummary = (deliveryCall?.payloads ?? []).map((payload) => ({
        text: payload.text ?? "",
        mediaUrl: payload.mediaUrl ?? null,
        mediaUrls: payload.mediaUrls ?? [],
      }));
      expect(payloadSummary, entry.name).toEqual(entry.expectedPayloads);
      expectRecordFields(
        deliveryCall?.mirror,
        {
          sessionKey: "agent:main:forum:dm:123456",
          text: entry.expectedMirror.text,
          mediaUrls: entry.expectedMirror.mediaUrls,
        },
        entry.name,
      );
    }
  });

  it("does not load registries while resolving outbound plugins", async () => {
    const forumPlugin = {
      outbound: { deliveryMode: "direct" },
    };
    mocks.getChannelPlugin
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(forumPlugin)
      .mockReturnValue(forumPlugin);

    const result = await sendMessage({
      cfg: { channels: { forum: { token: "test-token" } } },
      channel: "forum",
      to: "123456",
      content: "hi",
    });
    expectRecordFields(
      result,
      {
        channel: "forum",
        to: "123456",
        via: "direct",
      },
      "send message result",
    );

    expect(mocks.resolveRuntimePluginRegistry).not.toHaveBeenCalled();
  });

  it("does not throw best-effort direct send failures", async () => {
    mocks.deliverOutboundPayloads.mockImplementationOnce(async (params: unknown) => {
      (
        params as {
          onPayloadDeliveryOutcome?: (outcome: {
            index: number;
            payload: { text: string };
            status: "failed";
            error: Error;
            stage: "send";
          }) => void;
        }
      ).onPayloadDeliveryOutcome?.({
        index: 0,
        payload: { text: "hi" },
        status: "failed",
        error: new Error("transport unavailable"),
        stage: "send",
      });
      return [];
    });

    const result = await sendMessage({
      cfg: {},
      channel: "forum",
      to: "123456",
      content: "hi",
      bestEffort: true,
    });
    expectRecordFields(
      result,
      {
        channel: "forum",
        to: "123456",
        via: "direct",
        result: undefined,
      },
      "best-effort send message result",
    );

    expectDeliveryCallFields({
      bestEffort: true,
      queuePolicy: "best_effort",
    });
  });
});
