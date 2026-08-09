import type {
  QaBusInboundMessageInput,
  QaBusMessage,
} from "openclaw/plugin-sdk/qa-channel-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseBuzzQaCredentialPayload } from "./credentials.js";

const credentials = parseBuzzQaCredentialPayload({
  relayUrl: "wss://relay.qa.example",
  roomId: "123e4567-e89b-42d3-a456-426614174000",
  driverPrivateKey: "01".repeat(32),
  sutPrivateKey: "02".repeat(32),
});

const release = vi.hoisted(() => vi.fn(async () => {}));
const heartbeatStop = vi.hoisted(() => vi.fn(async () => {}));
const acquireQaCredentialLease = vi.hoisted(() =>
  vi.fn(async (_options: unknown) => ({
    source: "env" as const,
    kind: "buzz",
    payload: credentials,
    heartbeatIntervalMs: 0,
    leaseTtlMs: 0,
    heartbeat: vi.fn(async () => {}),
    release,
  })),
);
const startQaCredentialLeaseHeartbeat = vi.hoisted(() =>
  vi.fn((_lease: unknown) => ({
    getFailure: () => null,
    stop: heartbeatStop,
    throwIfFailed: vi.fn(),
  })),
);
const readBuzzQaCredentialFile = vi.hoisted(() => vi.fn());
const sendMessage = vi.hoisted(() =>
  vi.fn(async () => ({ eventId: "native-inbound", timestamp: 1_750_000_000_000 })),
);
const closeRelay = vi.hoisted(() => vi.fn(async () => {}));
const relayDriverState = vi.hoisted(() => ({
  onMessage: undefined as
    | ((message: {
        id: string;
        senderPubkey: string;
        text: string;
        channelId: string;
        createdAt: number;
        threadId?: string;
        replyToId?: string;
        mentionedPubkeys: string[];
      }) => Promise<void>)
    | undefined,
}));
const createBuzzQaRelayDriver = vi.hoisted(() =>
  vi.fn(async (params: { onMessage: NonNullable<typeof relayDriverState.onMessage> }) => {
    relayDriverState.onMessage = params.onMessage;
    return {
      assertHealthy: vi.fn(),
      close: closeRelay,
      sendMessage,
    };
  }),
);

vi.mock("./credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./credentials.js")>()),
  readBuzzQaCredentialFile,
}));
vi.mock("./relay-client.js", () => ({ createBuzzQaRelayDriver }));

import { createBuzzQaTransportAdapter } from "./adapter.runtime.js";

const credentialHost: Parameters<typeof createBuzzQaTransportAdapter>[0]["credentials"] = {
  acquire: async (options) => (await acquireQaCredentialLease(options)) as never,
  startHeartbeat: startQaCredentialLeaseHeartbeat,
};

describe("Buzz QA transport adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    relayDriverState.onMessage = undefined;
    sendMessage.mockResolvedValue({
      eventId: "native-inbound",
      timestamp: 1_750_000_000_000,
    });
    readBuzzQaCredentialFile.mockResolvedValue(credentials);
  });

  it("uses private file credentials by default", async () => {
    await createBuzzQaTransportAdapter({
      adapterOptions: {
        credentialFile: "private/buzz-qa.json",
        repoRoot: "/repo",
      },
      channelId: "buzz",
      credentials: credentialHost,
      driver: "live",
      messages: {
        addInboundMessage: vi.fn(),
        addOutboundMessage: vi.fn(),
        editMessage: vi.fn(),
      },
      outputDir: ".artifacts/qa-e2e/buzz",
    });

    expect(readBuzzQaCredentialFile).toHaveBeenCalledWith({
      filePath: "private/buzz-qa.json",
      repoRoot: "/repo",
    });
    expect(acquireQaCredentialLease).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "buzz", source: "env" }),
    );
  });

  it("sends a portable mentioned message through the native Buzz relay driver", async () => {
    const addInboundMessage = vi.fn(async (input) => ({
      ...input,
      id: "bus-inbound",
      direction: "inbound" as const,
      timestamp: input.timestamp ?? 1_750_000_000_000,
    }));
    const adapter = await createBuzzQaTransportAdapter({
      adapterOptions: { credentialSource: "convex", sutAccountId: "sut" },
      channelId: "buzz",
      credentials: credentialHost,
      driver: "live",
      messages: {
        addInboundMessage,
        addOutboundMessage: vi.fn(),
        editMessage: vi.fn(),
      },
      outputDir: ".artifacts/qa-e2e/buzz",
    });

    const message = await adapter.sendInbound({
      accountId: "sut",
      conversation: { id: "qa-routing-primary", kind: "group" },
      senderId: "driver",
      senderName: "QA Driver",
      text: "@openclaw reply exactly: QA-CHANNEL-CANARY-OK",
    });

    expect(sendMessage).toHaveBeenCalledWith({
      mentionSut: true,
      text: "@openclaw reply exactly: QA-CHANNEL-CANARY-OK",
    });
    expect(addInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "sut",
        senderId: credentials.driverPublicKey,
        timestamp: 1_750_000_000_000,
      }),
    );
    expect(message.id).toBe("bus-inbound");

    const gateway = {
      call: vi.fn(async () => ({
        channelAccounts: { buzz: [{ accountId: "default", running: true }] },
      })),
    };
    await adapter.waitReady({ gateway });
    expect(gateway.call).toHaveBeenCalledWith(
      "channels.status",
      { probe: false, timeoutMs: 2_000 },
      { timeoutMs: 5_000 },
    );
  });

  it("maps native Buzz reply relations back to portable thread ids", async () => {
    let inboundIndex = 0;
    let outboundIndex = 0;
    const addInboundMessage = vi.fn(async (input) => ({
      ...input,
      id: `bus-inbound-${++inboundIndex}`,
      direction: "inbound" as const,
      timestamp: input.timestamp ?? 1_750_000_000_000,
    }));
    const addOutboundMessage = vi.fn(async (input) => ({
      ...input,
      id: `bus-outbound-${++outboundIndex}`,
      direction: "outbound" as const,
      conversation: { id: "main", kind: "group" as const },
    }));
    sendMessage
      .mockResolvedValueOnce({ eventId: "native-root", timestamp: 1_750_000_000_000 })
      .mockResolvedValueOnce({ eventId: "native-follow-up", timestamp: 1_750_000_001_000 });
    const adapter = await createBuzzQaTransportAdapter({
      adapterOptions: { credentialSource: "convex", sutAccountId: "sut" },
      channelId: "buzz",
      credentials: credentialHost,
      driver: "live",
      messages: {
        addInboundMessage,
        addOutboundMessage,
        editMessage: vi.fn(),
      },
      outputDir: ".artifacts/qa-e2e/buzz",
    });

    const root = await adapter.sendInbound({
      accountId: "sut",
      conversation: { id: "main", kind: "group" },
      senderId: "driver",
      senderName: "QA Driver",
      text: "@openclaw root",
    });
    await relayDriverState.onMessage?.({
      id: "native-sut-root",
      senderPubkey: credentials.sutPublicKey,
      text: "root reply",
      channelId: credentials.roomId,
      createdAt: 1_750_000_000,
      threadId: "native-root",
      replyToId: "native-root",
      mentionedPubkeys: [],
    });
    const followUp = await adapter.sendInbound({
      accountId: "sut",
      conversation: { id: "main", kind: "group" },
      senderId: "driver",
      senderName: "QA Driver",
      text: "@openclaw follow-up",
      threadId: root.id,
    });
    await relayDriverState.onMessage?.({
      id: "native-sut-follow-up",
      senderPubkey: credentials.sutPublicKey,
      text: "thread reply",
      channelId: credentials.roomId,
      createdAt: 1_750_000_001,
      threadId: "native-root",
      replyToId: "native-follow-up",
      mentionedPubkeys: [],
    });

    expect(sendMessage).toHaveBeenLastCalledWith({
      mentionSut: true,
      text: "@openclaw follow-up",
      threadId: "native-root",
    });
    expect(addOutboundMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        threadId: root.id,
        replyToId: followUp.id,
      }),
    );
  });

  it("waits for a racing inbound id mapping before recording reply relations", async () => {
    let releaseInbound = () => {};
    const inboundGate = new Promise<void>((resolve) => {
      releaseInbound = resolve;
    });
    const addInboundMessage = vi.fn(async (input: QaBusInboundMessageInput) => {
      await inboundGate;
      return {
        ...input,
        id: "bus-inbound",
        accountId: input.accountId ?? "sut",
        direction: "inbound",
        timestamp: input.timestamp ?? 1_750_000_000_000,
        reactions: [],
      } satisfies QaBusMessage;
    });
    const addOutboundMessage = vi.fn(async (input) => ({
      ...input,
      id: "bus-outbound",
      direction: "outbound" as const,
      conversation: { id: "main", kind: "group" as const },
    }));
    const adapter = await createBuzzQaTransportAdapter({
      adapterOptions: { credentialSource: "convex", sutAccountId: "sut" },
      channelId: "buzz",
      credentials: credentialHost,
      driver: "live",
      messages: {
        addInboundMessage,
        addOutboundMessage,
        editMessage: vi.fn(),
      },
      outputDir: ".artifacts/qa-e2e/buzz",
    });

    const inboundPromise = adapter.sendInbound({
      accountId: "sut",
      conversation: { id: "main", kind: "group" },
      senderId: "driver",
      senderName: "QA Driver",
      text: "@openclaw root",
    });
    await vi.waitFor(() => expect(addInboundMessage).toHaveBeenCalledOnce());
    const outboundPromise = relayDriverState.onMessage?.({
      id: "native-sut-reply",
      senderPubkey: credentials.sutPublicKey,
      text: "fast reply",
      channelId: credentials.roomId,
      createdAt: 1_750_000_000,
      threadId: "native-inbound",
      replyToId: "native-inbound",
      mentionedPubkeys: [],
    });
    expect(addOutboundMessage).not.toHaveBeenCalled();

    releaseInbound();
    await inboundPromise;
    await outboundPromise;

    expect(addOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "bus-inbound",
        replyToId: "bus-inbound",
      }),
    );
  });

  it("closes relay observation before stopping and releasing the credential lease", async () => {
    const adapter = await createBuzzQaTransportAdapter({
      adapterOptions: { credentialSource: "convex" },
      channelId: "buzz",
      credentials: credentialHost,
      driver: "live",
      messages: {
        addInboundMessage: vi.fn(),
        addOutboundMessage: vi.fn(),
        editMessage: vi.fn(),
      },
      outputDir: ".artifacts/qa-e2e/buzz",
    });

    await adapter.cleanup?.();
    await adapter.cleanupAfterGatewayStop?.();

    expect(closeRelay).toHaveBeenCalledOnce();
    expect(heartbeatStop).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(closeRelay.mock.invocationCallOrder[0]).toBeLessThan(
      heartbeatStop.mock.invocationCallOrder[0] ?? 0,
    );
    expect(heartbeatStop.mock.invocationCallOrder[0]).toBeLessThan(
      release.mock.invocationCallOrder[0] ?? 0,
    );
  });
});
