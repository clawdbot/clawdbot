import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelGatewayContext } from "../runtime-api.js";
import type { BuzzBus } from "./buzz-bus.js";
import type { ResolvedBuzzAccount } from "./types.js";

const gatewayMocks = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  onMessage: undefined as
    | ((message: import("./message-event.js").BuzzInboundMessage, bus: BuzzBus) => Promise<void>)
    | undefined,
  onMessageError: undefined as ((error: Error) => void) | undefined,
  onFatalError: undefined as ((error: Error) => void) | undefined,
  startBuzzBus: vi.fn(),
}));

vi.mock("./buzz-bus.js", () => ({
  startBuzzBus: gatewayMocks.startBuzzBus,
}));

vi.mock("./inbound.js", () => ({
  handleBuzzInbound: vi.fn(async () => {}),
}));

import { startBuzzGatewayAccount } from "./gateway.js";
import { resolveBuzzAccount } from "./types.js";

const CHANNEL_ID = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";
const PRIVATE_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

describe("Buzz gateway lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gatewayMocks.onMessage = undefined;
    gatewayMocks.onMessageError = undefined;
    gatewayMocks.onFatalError = undefined;
    gatewayMocks.startBuzzBus.mockImplementation(
      async (options: {
        onMessage: (
          message: import("./message-event.js").BuzzInboundMessage,
          bus: BuzzBus,
        ) => Promise<void>;
        onMessageError?: (error: Error) => void;
        onFatalError?: (error: Error) => void;
      }): Promise<BuzzBus> => {
        gatewayMocks.onMessage = options.onMessage;
        gatewayMocks.onMessageError = options.onMessageError;
        gatewayMocks.onFatalError = options.onFatalError;
        return {
          publicKey: "a".repeat(64),
          sendText: async () => "event-id",
          close: gatewayMocks.close,
        };
      },
    );
  });

  it("restarts the account lifecycle when the bus reports a failure", async () => {
    const abortController = new AbortController();
    const cfg = {
      channels: {
        buzz: {
          relayUrl: "wss://buzz.example.com",
          privateKey: PRIVATE_KEY,
          groups: { [CHANNEL_ID]: {} },
        },
      },
    } as OpenClawConfig;
    const account = resolveBuzzAccount({ cfg });
    const setStatus = vi.fn();
    const ctx = {
      cfg,
      accountId: account.accountId,
      account,
      runtime: {},
      abortSignal: abortController.signal,
      log: { info: vi.fn(), error: vi.fn() },
      getStatus: vi.fn(),
      setStatus,
    } as unknown as ChannelGatewayContext<ResolvedBuzzAccount>;
    const lifecycle = startBuzzGatewayAccount(ctx);

    await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledOnce());
    gatewayMocks.onFatalError?.(new Error("relay failed"));

    await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
    expect(gatewayMocks.close).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenCalledWith({
      accountId: account.accountId,
      running: false,
      lastError: "relay failed",
    });

    abortController.abort();
    await expect(lifecycle).resolves.toBeUndefined();
    expect(gatewayMocks.close).toHaveBeenCalledTimes(2);
  });

  it("uses the rolling lookback after a failed initial session", async () => {
    gatewayMocks.startBuzzBus.mockRejectedValueOnce(new Error("connect failed"));
    const abortController = new AbortController();
    const cfg = {
      channels: {
        buzz: {
          relayUrl: "wss://buzz.example.com",
          privateKey: PRIVATE_KEY,
          groups: { [CHANNEL_ID]: {} },
        },
      },
    } as OpenClawConfig;
    const account = resolveBuzzAccount({ cfg });
    const ctx = {
      cfg,
      accountId: account.accountId,
      account,
      runtime: {},
      abortSignal: abortController.signal,
      log: { info: vi.fn(), error: vi.fn() },
      getStatus: vi.fn(),
      setStatus: vi.fn(),
    } as unknown as ChannelGatewayContext<ResolvedBuzzAccount>;
    const lifecycle = startBuzzGatewayAccount(ctx);

    await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
    const firstSince = gatewayMocks.startBuzzBus.mock.calls[0]?.[0].since as number;
    const secondSince = gatewayMocks.startBuzzBus.mock.calls[1]?.[0].since as number;
    expect(secondSince).toBeLessThanOrEqual(firstSince - 24 * 60 * 60 + 2);

    abortController.abort();
    await expect(lifecycle).resolves.toBeUndefined();
  });

  it("keeps the account running when one message fails", async () => {
    const abortController = new AbortController();
    const cfg = {
      channels: {
        buzz: {
          relayUrl: "wss://buzz.example.com",
          privateKey: PRIVATE_KEY,
          groups: { [CHANNEL_ID]: {} },
        },
      },
    } as OpenClawConfig;
    const account = resolveBuzzAccount({ cfg });
    const setStatus = vi.fn();
    const logError = vi.fn();
    const ctx = {
      cfg,
      accountId: account.accountId,
      account,
      runtime: {},
      abortSignal: abortController.signal,
      log: { info: vi.fn(), error: logError },
      getStatus: vi.fn(),
      setStatus,
    } as unknown as ChannelGatewayContext<ResolvedBuzzAccount>;
    const lifecycle = startBuzzGatewayAccount(ctx);

    await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledOnce());
    gatewayMocks.onMessageError?.(new Error("dispatch failed"));
    expect(logError).toHaveBeenCalledWith(
      `[${account.accountId}] Buzz message failed: dispatch failed`,
    );

    abortController.abort();
    await expect(lifecycle).resolves.toBeUndefined();
    expect(setStatus).toHaveBeenLastCalledWith({
      accountId: account.accountId,
      running: false,
    });
  });

  it("reconnects with a rolling lookback without trusting sender time", async () => {
    const abortController = new AbortController();
    const cfg = {
      channels: {
        buzz: {
          relayUrl: "wss://buzz.example.com",
          privateKey: PRIVATE_KEY,
          groups: { [CHANNEL_ID]: {} },
        },
      },
    } as OpenClawConfig;
    const account = resolveBuzzAccount({ cfg });
    const ctx = {
      cfg,
      accountId: account.accountId,
      account,
      runtime: {},
      abortSignal: abortController.signal,
      log: { info: vi.fn(), error: vi.fn() },
      getStatus: vi.fn(),
      setStatus: vi.fn(),
    } as unknown as ChannelGatewayContext<ResolvedBuzzAccount>;
    const lifecycle = startBuzzGatewayAccount(ctx);

    await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledOnce());
    const createdAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    await gatewayMocks.onMessage?.(
      {
        id: "event-1",
        channelId: CHANNEL_ID,
        senderPubkey: "b".repeat(64),
        text: "hello",
        createdAt,
        mentionedPubkeys: [],
      },
      {
        publicKey: "a".repeat(64),
        sendText: async () => "event-id",
        close: async () => {},
      },
    );
    const reconnectStartedAt = Math.floor(Date.now() / 1000);
    gatewayMocks.onFatalError?.(new Error("relay failed"));

    await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
    const secondSince = gatewayMocks.startBuzzBus.mock.calls[1]?.[0].since as number;
    expect(secondSince).toBeGreaterThanOrEqual(reconnectStartedAt - 24 * 60 * 60);
    expect(secondSince).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) - 24 * 60 * 60);
    expect(secondSince).toBeLessThan(createdAt);

    abortController.abort();
    await expect(lifecycle).resolves.toBeUndefined();
  });
});
