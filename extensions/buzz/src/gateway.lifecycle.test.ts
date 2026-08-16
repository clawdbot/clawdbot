import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelGatewayContext } from "../runtime-api.js";
import type { BuzzBus } from "./buzz-bus.js";
import type { ResolvedBuzzAccount } from "./types.js";

const gatewayMocks = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  busSendText: vi.fn(async () => "event-id"),
  busSendTyping: vi.fn(async () => undefined),
  sendBuzzTextOneShot: vi.fn(async () => "standalone-event-id"),
  onMessage: undefined as
    | ((
        message: import("./message-event.js").BuzzInboundMessage,
        bus: BuzzBus,
        signal: AbortSignal,
      ) => Promise<void>)
    | undefined,
  onMessageError: undefined as ((error: Error) => void) | undefined,
  onFatalError: undefined as ((error: Error) => void) | undefined,
  onRoomDirectoryChanged: undefined as (() => void) | undefined,
  resolveAgentIdentity: vi.fn(),
  resolveAgentRoute: vi.fn(),
  startBuzzBus: vi.fn(),
}));

vi.mock("./buzz-bus.js", () => ({
  sendBuzzTextOneShot: gatewayMocks.sendBuzzTextOneShot,
  startBuzzBus: gatewayMocks.startBuzzBus,
}));

vi.mock("./inbound.js", () => ({
  handleBuzzInbound: vi.fn(async () => {}),
}));

import { BuzzDirectoryState } from "./directory-state.js";
import { buzzOutboundAdapter, sendBuzzTyping, startBuzzGatewayAccount } from "./gateway.js";
import { BUZZ_NORMAL_MESSAGE_KIND } from "./message-event.js";
import { setBuzzRuntime } from "./runtime.js";
import { resolveBuzzAccount } from "./types.js";

const CHANNEL_ID = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";
const PRIVATE_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const BOT_PUBLIC_KEY = "a".repeat(64);

function createBuzzConfig(name?: string): OpenClawConfig {
  return {
    channels: {
      buzz: {
        ...(name ? { name } : {}),
        relayUrl: "wss://buzz.example.com",
        privateKey: PRIVATE_KEY,
        groups: { [CHANNEL_ID]: {} },
      },
    },
  } as OpenClawConfig;
}

function startTestGateway(
  options: {
    profileName?: string;
    setStatus?: ReturnType<typeof vi.fn>;
    logInfo?: ReturnType<typeof vi.fn>;
    logError?: ReturnType<typeof vi.fn>;
    invalidateDirectoryCache?: ReturnType<typeof vi.fn>;
    omitLog?: boolean;
  } = {},
) {
  const abortController = new AbortController();
  const cfg = createBuzzConfig(options.profileName);
  const account = resolveBuzzAccount({ cfg });
  const setStatus = options.setStatus ?? vi.fn();
  const lifecycle = startBuzzGatewayAccount({
    cfg,
    accountId: account.accountId,
    account,
    runtime: {},
    abortSignal: abortController.signal,
    ...(options.omitLog
      ? {}
      : { log: { info: options.logInfo ?? vi.fn(), error: options.logError ?? vi.fn() } }),
    getStatus: vi.fn(),
    setStatus,
    invalidateDirectoryCache: options.invalidateDirectoryCache,
  } as unknown as ChannelGatewayContext<ResolvedBuzzAccount>);
  return { abortController, cfg, account, setStatus, lifecycle };
}

function createMockBus(): BuzzBus {
  return {
    publicKey: BOT_PUBLIC_KEY,
    directory: new BuzzDirectoryState({
      publicKey: BOT_PUBLIC_KEY,
      fallbackProfileName: "OpenClaw",
      channelIds: [CHANNEL_ID],
    }),
    refreshDirectory: vi.fn(async () => {}),
    sendText: gatewayMocks.busSendText,
    sendTyping: gatewayMocks.busSendTyping,
    close: gatewayMocks.close,
  };
}

describe("Buzz gateway lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gatewayMocks.onMessage = undefined;
    gatewayMocks.onMessageError = undefined;
    gatewayMocks.onFatalError = undefined;
    gatewayMocks.onRoomDirectoryChanged = undefined;
    gatewayMocks.busSendText.mockResolvedValue("event-id");
    gatewayMocks.busSendTyping.mockResolvedValue(undefined);
    gatewayMocks.sendBuzzTextOneShot.mockResolvedValue("standalone-event-id");
    gatewayMocks.resolveAgentIdentity.mockReset().mockReturnValue(undefined);
    gatewayMocks.resolveAgentRoute.mockReset().mockReturnValue({ agentId: "main" });
    setBuzzRuntime({
      agent: {
        resolveAgentIdentity: gatewayMocks.resolveAgentIdentity,
      },
      channel: {
        routing: {
          resolveAgentRoute: gatewayMocks.resolveAgentRoute,
        },
        text: {
          resolveMarkdownTableMode: () => "preserve",
          convertMarkdownTables: (text: string) => text,
        },
      },
    } as never);
    gatewayMocks.startBuzzBus.mockImplementation(
      async (options: {
        onMessage: (
          message: import("./message-event.js").BuzzInboundMessage,
          bus: BuzzBus,
          signal: AbortSignal,
        ) => Promise<void>;
        onMessageError?: (error: Error) => void;
        onFatalError?: (error: Error) => void;
        onRoomDirectoryChanged?: () => void;
      }): Promise<BuzzBus> => {
        gatewayMocks.onMessage = options.onMessage;
        gatewayMocks.onMessageError = options.onMessageError;
        gatewayMocks.onFatalError = options.onFatalError;
        gatewayMocks.onRoomDirectoryChanged = options.onRoomDirectoryChanged;
        return createMockBus();
      },
    );
  });

  it("reports the account-scoped groups path for a named account", async () => {
    const cfg = {
      channels: {
        buzz: {
          accounts: {
            ada: {
              relayUrl: "wss://ada.example.com",
              privateKey: PRIVATE_KEY,
            },
          },
        },
      },
    } as OpenClawConfig;
    const account = resolveBuzzAccount({ cfg, accountId: "ada" });

    await expect(
      startBuzzGatewayAccount({
        cfg,
        accountId: account.accountId,
        account,
        runtime: {},
        abortSignal: new AbortController().signal,
        getStatus: vi.fn(),
        setStatus: vi.fn(),
      } as unknown as ChannelGatewayContext<ResolvedBuzzAccount>),
    ).rejects.toThrow(
      'Buzz account "ada" requires at least one channels.buzz.accounts.ada.groups entry',
    );
    expect(gatewayMocks.startBuzzBus).not.toHaveBeenCalled();
  });

  it("invalidates cached room targets after initial discovery and newer room metadata", async () => {
    const invalidateDirectoryCache = vi.fn();
    const { abortController, lifecycle } = startTestGateway({
      invalidateDirectoryCache,
      omitLog: true,
    });

    await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledOnce());
    expect(invalidateDirectoryCache).toHaveBeenCalledOnce();
    gatewayMocks.onRoomDirectoryChanged?.();
    expect(invalidateDirectoryCache).toHaveBeenCalledTimes(2);

    abortController.abort();
    await expect(lifecycle).resolves.toBeUndefined();
  });

  it("restarts the account lifecycle when the bus reports a failure", async () => {
    gatewayMocks.resolveAgentIdentity.mockReturnValue({ name: "Molt" });
    const setStatus = vi.fn();
    const { abortController, account, lifecycle } = startTestGateway({ setStatus });

    await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledOnce());
    expect(gatewayMocks.startBuzzBus.mock.calls[0]?.[0].profileName).toBe("Molt");
    expect(setStatus).toHaveBeenCalledWith({
      accountId: account.accountId,
      running: true,
      connected: true,
      lifecycle: "ready",
      lastConnectedAt: expect.any(Number),
      configured: true,
      enabled: account.enabled,
      baseUrl: account.relayUrl,
      publicKey: BOT_PUBLIC_KEY,
      lastError: null,
      terminalDisconnect: undefined,
    });
    gatewayMocks.onFatalError?.(new Error("relay failed"));

    await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
    expect(gatewayMocks.close).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenCalledWith({
      accountId: account.accountId,
      running: false,
      lifecycle: "recovering",
      lastError: "relay failed",
    });

    abortController.abort();
    await expect(lifecycle).resolves.toBeUndefined();
    expect(gatewayMocks.close).toHaveBeenCalledTimes(2);
  });

  it("uses a one-shot authenticated connection when no gateway bus is running", async () => {
    const cfg = createBuzzConfig();

    const result = await buzzOutboundAdapter.sendText({
      cfg,
      to: `buzz:${CHANNEL_ID}`,
      text: "hello",
      accountId: "default",
      threadId: "root-id",
      replyToId: "parent-id",
    });

    expect(gatewayMocks.sendBuzzTextOneShot).toHaveBeenCalledWith({
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      authTag: "",
      channelId: CHANNEL_ID,
      text: "hello",
      threadId: "root-id",
      replyToId: "parent-id",
    });
    expect(result).toEqual({
      channel: "buzz",
      to: CHANNEL_ID,
      messageId: "standalone-event-id",
    });
  });

  it("drops heartbeat typing when no gateway bus is running", async () => {
    const cfg = createBuzzConfig();

    await sendBuzzTyping({
      cfg,
      to: `buzz:${CHANNEL_ID}`,
      accountId: "default",
      threadId: "root-id",
    });

    expect(gatewayMocks.busSendTyping).not.toHaveBeenCalled();
    expect(gatewayMocks.sendBuzzTextOneShot).not.toHaveBeenCalled();
  });

  it("reuses the gateway bus for sends in the running process", async () => {
    const { abortController, cfg, lifecycle } = startTestGateway({ profileName: "BuzzClaw" });
    await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledOnce());
    expect(gatewayMocks.startBuzzBus.mock.calls[0]?.[0].profileName).toBe("BuzzClaw");
    expect(gatewayMocks.resolveAgentRoute).not.toHaveBeenCalled();

    await buzzOutboundAdapter.sendText({
      cfg,
      to: `buzz:${CHANNEL_ID}`,
      text: "hello",
      accountId: "default",
    });

    expect(gatewayMocks.busSendText).toHaveBeenCalledWith({
      channelId: CHANNEL_ID,
      text: "hello",
      threadId: undefined,
      replyToId: undefined,
    });
    expect(gatewayMocks.sendBuzzTextOneShot).not.toHaveBeenCalled();

    abortController.abort();
    await expect(lifecycle).resolves.toBeUndefined();
  });

  it("uses the active bus for heartbeat typing without destabilizing the account", async () => {
    const { abortController, cfg, lifecycle } = startTestGateway();
    await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledOnce());

    await sendBuzzTyping({
      cfg,
      to: `buzz:${CHANNEL_ID}`,
      accountId: "default",
      threadId: "root-id",
    });
    expect(gatewayMocks.busSendTyping).toHaveBeenCalledWith({
      channelId: CHANNEL_ID,
      threadId: "root-id",
    });

    gatewayMocks.busSendTyping.mockRejectedValueOnce(new Error("socket closing"));
    await expect(
      sendBuzzTyping({
        cfg,
        to: `buzz:${CHANNEL_ID}`,
        accountId: "default",
      }),
    ).rejects.toThrow("socket closing");
    expect(gatewayMocks.startBuzzBus).toHaveBeenCalledOnce();
    expect(gatewayMocks.close).not.toHaveBeenCalled();

    abortController.abort();
    await expect(lifecycle).resolves.toBeUndefined();
  });

  it("uses the rolling lookback after a failed initial session", async () => {
    gatewayMocks.startBuzzBus.mockRejectedValueOnce(new Error("connect failed"));
    const { abortController, lifecycle } = startTestGateway();

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
    const setStatus = vi.fn();
    const logError = vi.fn();
    const { abortController, account, lifecycle } = startTestGateway({ setStatus, logError });

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
    const invalidateDirectoryCache = vi.fn();
    const { abortController, lifecycle } = startTestGateway({ invalidateDirectoryCache });

    await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledOnce());
    const createdAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    await gatewayMocks.onMessage?.(
      {
        id: "event-1",
        kind: BUZZ_NORMAL_MESSAGE_KIND,
        channelId: CHANNEL_ID,
        senderPubkey: "b".repeat(64),
        text: "hello",
        createdAt,
        mentionedPubkeys: [],
      },
      createMockBus(),
      new AbortController().signal,
    );
    const reconnectStartedAt = Math.floor(Date.now() / 1000);
    gatewayMocks.onFatalError?.(new Error("relay failed"));

    await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
    expect(invalidateDirectoryCache).toHaveBeenCalledTimes(2);
    const secondSince = gatewayMocks.startBuzzBus.mock.calls[1]?.[0].since as number;
    expect(secondSince).toBeGreaterThanOrEqual(reconnectStartedAt - 24 * 60 * 60);
    expect(secondSince).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) - 24 * 60 * 60);
    expect(secondSince).toBeLessThan(createdAt);

    abortController.abort();
    await expect(lifecycle).resolves.toBeUndefined();
  });
});
