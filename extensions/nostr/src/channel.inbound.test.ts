import { createStartAccountContext } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import { startNostrGatewayAccount } from "./gateway.js";
import { setNostrRuntime } from "./runtime.js";
import { buildResolvedNostrAccount } from "./test-fixtures.js";

const mocks = vi.hoisted(() => ({
  normalizePubkey: vi.fn((value: string) =>
    value
      .trim()
      .replace(/^nostr:/i, "")
      .toLowerCase(),
  ),
  startNostrBus: vi.fn(),
}));

vi.mock("./nostr-bus.js", () => ({
  DEFAULT_RELAYS: ["wss://relay.example.com"],
  startNostrBus: mocks.startNostrBus,
}));

vi.mock("./nostr-key-utils.js", () => ({
  getPublicKeyFromPrivate: vi.fn(() => "bot-pubkey"),
  normalizePubkey: mocks.normalizePubkey,
}));

function createMockBus() {
  return {
    sendDm: vi.fn(async () => {}),
    close: vi.fn(),
    getMetrics: vi.fn(() => ({ counters: {} })),
    publishProfile: vi.fn(),
    getProfileState: vi.fn(async () => null),
  };
}

function createRuntimeHarness() {
  const recordInboundSession = vi.fn(async () => {});
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ dispatcherOptions }) => {
    await dispatcherOptions.deliver({ text: "|a|b|" });
  });
  const runtime = {
    channel: {
      text: {
        resolveMarkdownTableMode: vi.fn(() => "off"),
        convertMarkdownTables: vi.fn((text: string) => `converted:${text}`),
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn(() => true),
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => true),
      },
      routing: {
        resolveAgentRoute: vi.fn(({ accountId, peer }) => ({
          agentId: "agent-nostr",
          accountId,
          sessionKey: `nostr:${peer.id}`,
        })),
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/nostr-session-store"),
        readSessionUpdatedAt: vi.fn(() => undefined),
        recordInboundSession,
      },
      reply: {
        formatAgentEnvelope: vi.fn(({ body }) => `envelope:${body}`),
        resolveEnvelopeFormatOptions: vi.fn(() => ({ mode: "agent" })),
        finalizeInboundContext: vi.fn((ctx) => ctx),
        dispatchReplyWithBufferedBlockDispatcher,
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => ({ code: "PAIR1234", created: true })),
      },
    },
  } as unknown as PluginRuntime;

  return {
    runtime,
    recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher,
  };
}

async function startGatewayHarness(params: {
  account: ReturnType<typeof buildResolvedNostrAccount>;
  cfg?: Parameters<typeof createStartAccountContext>[0]["cfg"];
}) {
  const harness = createRuntimeHarness();
  const bus = createMockBus();
  setNostrRuntime(harness.runtime);
  mocks.startNostrBus.mockResolvedValueOnce(bus as never);

  const cleanup = (await startNostrGatewayAccount(
    createStartAccountContext({
      account: params.account,
      cfg: params.cfg,
    }),
  )) as { stop: () => void };

  return { harness, bus, cleanup };
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

describe("nostr inbound gateway path", () => {
  afterEach(() => {
    mocks.normalizePubkey.mockClear();
    mocks.startNostrBus.mockReset();
  });

  it("issues a pairing reply before decrypt for unknown senders", async () => {
    const { cleanup } = await startGatewayHarness({
      account: buildResolvedNostrAccount({
        config: { dmPolicy: "pairing", allowFrom: [] },
      }),
    });

    const options = mockCallArg(mocks.startNostrBus) as {
      authorizeSender: (params: {
        senderPubkey: string;
        reply: (text: string) => Promise<void>;
      }) => Promise<string>;
    };
    const sendPairingReply = vi.fn(async (_text: string) => {});

    await expect(
      options.authorizeSender({
        senderPubkey: "nostr:UNKNOWN-SENDER",
        reply: sendPairingReply,
      }),
    ).resolves.toBe("pairing");
    expect(sendPairingReply).toHaveBeenCalledTimes(1);
    expect(mockCallArg(sendPairingReply)).toContain("Pairing code:");

    cleanup.stop();
  });

  it("routes allowed DMs through the standard reply pipeline", async () => {
    const { harness, cleanup } = await startGatewayHarness({
      account: buildResolvedNostrAccount({
        publicKey: "bot-pubkey",
        config: { dmPolicy: "allowlist", allowFrom: ["nostr:sender-pubkey"] },
      }),
      cfg: {
        session: { store: { type: "jsonl" } },
        commands: { useAccessGroups: true },
      } as never,
    });

    const options = mockCallArg(mocks.startNostrBus) as {
      onMessage: (
        senderPubkey: string,
        text: string,
        reply: (text: string) => Promise<void>,
        meta: { eventId: string; createdAt: number },
      ) => Promise<void>;
    };
    const sendReply = vi.fn(async (_text: string) => {});

    await options.onMessage("sender-pubkey", "hello from nostr", sendReply, {
      eventId: "event-123",
      createdAt: 1_710_000_000,
    });

    expect(harness.recordInboundSession).toHaveBeenCalledTimes(1);
    expect(harness.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    const ctx = (
      mockCallArg(harness.dispatchReplyWithBufferedBlockDispatcher) as {
        ctx?: Record<string, unknown>;
      }
    ).ctx;
    expect(ctx?.BodyForAgent).toBe("hello from nostr");
    expect(ctx?.SenderId).toBe("sender-pubkey");
    expect(ctx?.MessageSid).toBe("event-123");
    expect(ctx?.CommandAuthorized).toBe(true);
    expect(sendReply).toHaveBeenCalledWith("converted:|a|b|");

    cleanup.stop();
  });
});
