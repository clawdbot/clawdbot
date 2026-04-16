import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn(),
  resolveOutboundTarget: vi.fn(),
  deliverOutboundPayloads: vi.fn(),
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
}));

import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

let sendMessage: typeof import("./message.js").sendMessage;
let resetOutboundChannelResolutionStateForTest: typeof import("./channel-resolution.js").resetOutboundChannelResolutionStateForTest;

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
    mocks.resolveRuntimePluginRegistry.mockClear();

    mocks.getChannelPlugin.mockReturnValue({
      outbound: { deliveryMode: "direct" },
    });
    mocks.resolveOutboundTarget.mockImplementation(({ to }: { to: string }) => ({ ok: true, to }));
    mocks.deliverOutboundPayloads.mockResolvedValue([{ channel: "mattermost", messageId: "m1" }]);
  });

  it("passes explicit agentId to outbound delivery for scoped media roots", async () => {
    await sendMessage({
      cfg: {},
      channel: "telegram",
      to: "123456",
      content: "hi",
      agentId: "work",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ agentId: "work" }),
        channel: "telegram",
        to: "123456",
      }),
    );
  });

  it("forwards requesterSenderId into the outbound delivery session", async () => {
    await sendMessage({
      cfg: {},
      channel: "telegram",
      to: "123456",
      content: "hi",
      requesterSenderId: "attacker",
      mirror: {
        sessionKey: "agent:main:telegram:group:ops",
      },
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          key: "agent:main:telegram:group:ops",
          requesterSenderId: "attacker",
        }),
      }),
    );
  });

  it("forwards non-id requester sender fields into the outbound delivery session", async () => {
    await sendMessage({
      cfg: {},
      channel: "telegram",
      to: "123456",
      content: "hi",
      requesterSenderName: "Alice",
      requesterSenderUsername: "alice_u",
      requesterSenderE164: "+15551234567",
      mirror: {
        sessionKey: "agent:main:telegram:group:ops",
      },
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          key: "agent:main:telegram:group:ops",
          requesterSenderName: "Alice",
          requesterSenderUsername: "alice_u",
          requesterSenderE164: "+15551234567",
        }),
      }),
    );
  });

  it("uses requester session/account for outbound delivery policy context", async () => {
    await sendMessage({
      cfg: {},
      channel: "telegram",
      to: "123456",
      content: "hi",
      requesterSessionKey: "agent:main:whatsapp:group:ops",
      requesterAccountId: "work",
      requesterSenderId: "attacker",
      mirror: {
        sessionKey: "agent:main:telegram:dm:123456",
      },
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          key: "agent:main:whatsapp:group:ops",
          requesterAccountId: "work",
          requesterSenderId: "attacker",
        }),
        mirror: expect.objectContaining({
          sessionKey: "agent:main:telegram:dm:123456",
        }),
      }),
    );
  });

  it("propagates the send idempotency key into mirrored transcript delivery", async () => {
    await sendMessage({
      cfg: {},
      channel: "telegram",
      to: "123456",
      content: "hi",
      idempotencyKey: "idem-send-1",
      mirror: {
        sessionKey: "agent:main:telegram:dm:123456",
      },
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          sessionKey: "agent:main:telegram:dm:123456",
          text: "hi",
          idempotencyKey: "idem-send-1",
        }),
      }),
    );
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
        channel: "telegram",
        to: "123456",
        content: entry.content,
        ...(entry.mediaUrl ? { mediaUrl: entry.mediaUrl } : {}),
        mirror: {
          sessionKey: "agent:main:telegram:dm:123456",
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
      expect(deliveryCall?.mirror, entry.name).toEqual(
        expect.objectContaining({
          sessionKey: "agent:main:telegram:dm:123456",
          text: entry.expectedMirror.text,
          mediaUrls: entry.expectedMirror.mediaUrls,
        }),
      );
    }
  });

  it("recovers telegram plugin resolution so message/send does not fail with Unknown channel: telegram", async () => {
    const telegramPlugin = {
      outbound: { deliveryMode: "direct" },
    };
    mocks.getChannelPlugin
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(telegramPlugin)
      .mockReturnValue(telegramPlugin);

    await expect(
      sendMessage({
        cfg: { channels: { telegram: { botToken: "test-token" } } },
        channel: "telegram",
        to: "123456",
        content: "hi",
      }),
    ).resolves.toMatchObject({
      channel: "telegram",
      to: "123456",
      via: "direct",
    });

    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledTimes(1);
  });
});
