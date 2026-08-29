import { createStartAccountContext } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuzzBus } from "./buzz-bus.js";

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
        assertCurrent: () => void,
      ) => Promise<void>)
    | undefined,
  onMessageError: undefined as ((error: Error) => void) | undefined,
  onFatalError: undefined as ((error: Error) => void) | undefined,
  onRoomDirectoryChanged: undefined as (() => void) | undefined,
  resolveAgentIdentity: vi.fn(),
  resolveAgentRoute: vi.fn(),
  recoveryLookup: vi.fn(),
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
import {
  buzzOutboundAdapter,
  getActiveBuzzBus,
  sendBuzzTyping,
  startBuzzGatewayAccount,
} from "./gateway.js";
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

function createUnavailableBuzzConfig(credential: "privateKey" | "authTag"): OpenClawConfig {
  vi.stubEnv("BUZZ_PRIVATE_KEY", PRIVATE_KEY);
  vi.stubEnv("BUZZ_AUTH_TAG", "ambient-auth-tag");
  return {
    channels: {
      buzz: {
        relayUrl: "wss://buzz.example.com",
        privateKey: PRIVATE_KEY,
        groups: { [CHANNEL_ID]: {} },
        [credential]: {
          source: "env",
          provider: "default",
          id: credential === "privateKey" ? "MISSING_BUZZ_PRIVATE_KEY" : "MISSING_BUZZ_AUTH_TAG",
        },
      },
    },
  } as OpenClawConfig;
}

function startTestGateway(
  options: {
    profileName?: string;
    setStatus?: Parameters<typeof startBuzzGatewayAccount>[0]["setStatus"];
    logInfo?: NonNullable<Parameters<typeof startBuzzGatewayAccount>[0]["log"]>["info"];
    logError?: NonNullable<Parameters<typeof startBuzzGatewayAccount>[0]["log"]>["error"];
    invalidateDirectoryCache?: Parameters<
      typeof startBuzzGatewayAccount
    >[0]["invalidateDirectoryCache"];
    omitLog?: boolean;
  } = {},
) {
  const abortController = new AbortController();
  const cfg = createBuzzConfig(options.profileName);
  const account = resolveBuzzAccount({ cfg });
  const setStatus = options.setStatus ?? vi.fn();
  const lifecycle = startBuzzGatewayAccount({
    ...createStartAccountContext({ account, abortSignal: abortController.signal, cfg }),
    log: options.omitLog
      ? undefined
      : { info: options.logInfo ?? vi.fn(), warn: vi.fn(), error: options.logError ?? vi.fn() },
    setStatus,
    invalidateDirectoryCache: options.invalidateDirectoryCache,
  });
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

function resolveBusSince(callIndex: number): number {
  const since = gatewayMocks.startBuzzBus.mock.calls[callIndex]?.[0].since as (
    channelId: string,
  ) => number;
  return since(CHANNEL_ID);
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
    const recoveryRooms = new Map<string, { seconds: number }>();
    gatewayMocks.recoveryLookup.mockImplementation(async (key: string) => recoveryRooms.get(key));
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
      state: {
        openKeyedStore: () => ({
          lookup: gatewayMocks.recoveryLookup,
          register: async (key: string, value: { seconds: number }) => {
            recoveryRooms.set(key, value);
          },
          entries: async () => Array.from(recoveryRooms, ([key, value]) => ({ key, value })),
          delete: async (key: string) => recoveryRooms.delete(key),
        }),
      },
    } as never);
    gatewayMocks.startBuzzBus.mockImplementation(
      async (options: {
        onMessage: (
          message: import("./message-event.js").BuzzInboundMessage,
          bus: BuzzBus,
          signal: AbortSignal,
          assertCurrent: () => void,
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

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each(
    [
      { label: "implicit root", accountId: "default", nested: false, path: "channels.buzz" },
      { label: "named", accountId: "ada", nested: true, path: "channels.buzz.accounts.ada" },
      {
        label: "explicit default",
        accountId: "default",
        nested: true,
        path: "channels.buzz.accounts.default",
      },
    ].flatMap((scope) =>
      [
        { rooms: "missing", groups: undefined },
        { rooms: "empty", groups: {} },
        { rooms: "disabled", groups: { [CHANNEL_ID]: { enabled: false } } },
      ].map((rooms) => Object.assign({}, scope, rooms)),
    ),
  )(
    "reports the $label account path when rooms are $rooms",
    async ({ accountId, nested, path, groups }) => {
      const cfg = createBuzzConfig();
      const selected = { relayUrl: "wss://buzz.example.com", privateKey: PRIVATE_KEY, groups };
      cfg.channels!.buzz = nested
        ? { ...cfg.channels!.buzz, accounts: { [accountId]: selected } }
        : selected;
      const account = resolveBuzzAccount({ cfg, accountId });
      const abortController = new AbortController();
      await expect(
        startBuzzGatewayAccount(
          createStartAccountContext({ account, cfg, abortSignal: abortController.signal }),
        ),
      ).rejects.toThrow(`Buzz requires at least one enabled ${path}.groups entry`);
      expect(gatewayMocks.startBuzzBus).not.toHaveBeenCalled();
      expect(gatewayMocks.recoveryLookup).not.toHaveBeenCalled();
    },
  );

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

  it("reports unreadable recovery state without connecting or skipping room history", async () => {
    gatewayMocks.recoveryLookup.mockRejectedValueOnce(new Error("room activation unreadable"));
    const setStatus = vi.fn();
    const { abortController, lifecycle } = startTestGateway({ setStatus });

    await vi.waitFor(() =>
      expect(setStatus).toHaveBeenCalledWith({
        accountId: "default",
        running: false,
        lifecycle: "recovering",
        lastError: "room activation unreadable",
      }),
    );
    expect(gatewayMocks.startBuzzBus).not.toHaveBeenCalled();

    abortController.abort();
    await expect(lifecycle).resolves.toBeUndefined();
  });

  it("restarts the account lifecycle when the bus reports a failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
    await vi.advanceTimersByTimeAsync(1_200);

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

  it("routes a named default send with only that account's credentials", async () => {
    const cfg = createBuzzConfig();
    cfg.channels!.buzz = {
      ...cfg.channels!.buzz,
      defaultAccount: "ada",
      authTag: "root-auth",
      accounts: { ada: { relayUrl: "wss://ada.example.com", privateKey: "22".repeat(32) } },
    };
    await buzzOutboundAdapter.sendText({ cfg, to: CHANNEL_ID, text: "Ada says hello" });
    expect(gatewayMocks.sendBuzzTextOneShot).toHaveBeenCalledWith(
      expect.objectContaining({
        relayUrl: "wss://ada.example.com",
        privateKey: "22".repeat(32),
        authTag: "",
        text: "Ada says hello",
      }),
    );
  });

  it("preserves an explicit send's thread even when automatic replies are flat", async () => {
    const cfg = createBuzzConfig();
    const flatCfg = {
      ...cfg,
      channels: { ...cfg.channels, buzz: { ...cfg.channels?.buzz, replyToMode: "off" as const } },
    };
    await buzzOutboundAdapter.sendText({
      cfg: flatCfg,
      to: CHANNEL_ID,
      text: "explicit thread send",
      threadId: "requested-thread",
      replyToId: "requested-parent",
    });
    expect(gatewayMocks.sendBuzzTextOneShot).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "requested-thread",
        replyToId: "requested-parent",
        text: "explicit thread send",
      }),
    );
  });

  it("blocks direct sends before opening a relay when an auth-tag SecretRef is unavailable", async () => {
    const cfg = createUnavailableBuzzConfig("authTag");

    await expect(
      buzzOutboundAdapter.sendText({
        cfg,
        to: `buzz:${CHANNEL_ID}`,
        text: "must not send",
        accountId: "default",
      }),
    ).rejects.toThrow(/configured.*unavailable|unresolved/i);
    expect(gatewayMocks.sendBuzzTextOneShot).not.toHaveBeenCalled();
    expect(gatewayMocks.busSendText).not.toHaveBeenCalled();
  });

  it("blocks gateway startup before opening a relay when a private-key SecretRef is unavailable", async () => {
    const cfg = createUnavailableBuzzConfig("privateKey");
    const account = resolveBuzzAccount({ cfg });

    await expect(
      startBuzzGatewayAccount(createStartAccountContext({ account, cfg })),
    ).rejects.toThrow(/configured.*unavailable|unresolved/i);
    expect(gatewayMocks.startBuzzBus).not.toHaveBeenCalled();
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

  it.each(["resolves", "rejects"] as const)(
    "retires the active bus before asynchronous shutdown %s",
    async (closeOutcome) => {
      let resolveClose: (() => void) | undefined;
      let rejectClose: ((error: Error) => void) | undefined;
      const closePending = new Promise<void>((resolve, reject) => {
        resolveClose = resolve;
        rejectClose = reject;
      });
      gatewayMocks.close.mockImplementationOnce(() => closePending);
      const { abortController, cfg, account, lifecycle, setStatus } = startTestGateway();

      try {
        await vi.waitFor(() => expect(getActiveBuzzBus(account.accountId)).toBeDefined());
        abortController.abort();
        await vi.waitFor(() => expect(gatewayMocks.close).toHaveBeenCalledOnce());

        expect(getActiveBuzzBus(account.accountId)).toBeUndefined();
        expect(setStatus).not.toHaveBeenCalledWith({
          accountId: account.accountId,
          running: false,
        });

        const pendingResult = await buzzOutboundAdapter.sendText({
          cfg,
          to: `buzz:${CHANNEL_ID}`,
          text: "while closing",
          accountId: account.accountId,
        });
        await sendBuzzTyping({
          cfg,
          to: `buzz:${CHANNEL_ID}`,
          accountId: account.accountId,
        });

        expect(pendingResult.messageId).toBe("standalone-event-id");
        expect(gatewayMocks.sendBuzzTextOneShot).toHaveBeenCalledOnce();
        expect(gatewayMocks.busSendText).not.toHaveBeenCalled();
        expect(gatewayMocks.busSendTyping).not.toHaveBeenCalled();

        if (closeOutcome === "rejects") {
          const closeError = new Error("Buzz close failed");
          rejectClose?.(closeError);
          await expect(lifecycle).rejects.toBe(closeError);
          expect(setStatus).not.toHaveBeenCalledWith({
            accountId: account.accountId,
            running: false,
          });
        } else {
          resolveClose?.();
          await expect(lifecycle).resolves.toBeUndefined();
          expect(setStatus).toHaveBeenLastCalledWith({
            accountId: account.accountId,
            running: false,
          });
        }

        expect(getActiveBuzzBus(account.accountId)).toBeUndefined();
        await buzzOutboundAdapter.sendText({
          cfg,
          to: `buzz:${CHANNEL_ID}`,
          text: "after closing",
          accountId: account.accountId,
        });
        await sendBuzzTyping({
          cfg,
          to: `buzz:${CHANNEL_ID}`,
          accountId: account.accountId,
        });
        expect(gatewayMocks.sendBuzzTextOneShot).toHaveBeenCalledTimes(2);
        expect(gatewayMocks.busSendText).not.toHaveBeenCalled();
        expect(gatewayMocks.busSendTyping).not.toHaveBeenCalled();
      } finally {
        abortController.abort();
        resolveClose?.();
        await lifecycle.catch(() => undefined);
      }
    },
  );

  it("does not retire a replacement bus when an earlier generation finishes closing", async () => {
    let resolveClose: (() => void) | undefined;
    const closePending = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    gatewayMocks.close.mockImplementationOnce(() => closePending);
    const first = startTestGateway();
    let replacement: ReturnType<typeof startTestGateway> | undefined;

    try {
      await vi.waitFor(() => expect(getActiveBuzzBus(first.account.accountId)).toBeDefined());
      replacement = startTestGateway();
      await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledTimes(2));
      const replacementBus = getActiveBuzzBus(first.account.accountId);
      expect(replacementBus).toBeDefined();

      first.abortController.abort();
      await vi.waitFor(() => expect(gatewayMocks.close).toHaveBeenCalledOnce());
      expect(getActiveBuzzBus(first.account.accountId)).toBe(replacementBus);

      resolveClose?.();
      await expect(first.lifecycle).resolves.toBeUndefined();
      expect(getActiveBuzzBus(first.account.accountId)).toBe(replacementBus);
    } finally {
      first.abortController.abort();
      resolveClose?.();
      await first.lifecycle.catch(() => undefined);
      replacement?.abortController.abort();
      await replacement?.lifecycle.catch(() => undefined);
    }
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

  it.each(["all", "off"] as const)(
    "uses %s-mode heartbeat typing without destabilizing the account",
    async (replyToMode) => {
      const { abortController, cfg, lifecycle } = startTestGateway();
      await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledOnce());
      const typingCfg = {
        ...cfg,
        channels: { ...cfg.channels, buzz: { ...cfg.channels?.buzz, replyToMode } },
      };

      await sendBuzzTyping({
        cfg: typingCfg,
        to: `buzz:${CHANNEL_ID}`,
        accountId: "default",
        threadId: "root-id",
      });
      expect(gatewayMocks.busSendTyping).toHaveBeenCalledWith({
        channelId: CHANNEL_ID,
        threadId: replyToMode === "off" ? undefined : "root-id",
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
    },
  );

  it.each(["root", "account"])(
    "drops typing for a %s-disabled named identity even with an active bus",
    async (disabledScope) => {
      const cfg = createBuzzConfig();
      cfg.channels!.buzz = {
        ...cfg.channels!.buzz,
        defaultAccount: "ada",
        accounts: {
          ada: {
            relayUrl: "wss://ada.example.com",
            privateKey: "22".repeat(32),
            groups: { [CHANNEL_ID]: {} },
            replyToMode: "off",
          },
        },
      };
      const account = resolveBuzzAccount({ cfg });
      const controller = new AbortController();
      const lifecycle = startBuzzGatewayAccount(
        createStartAccountContext({ account, cfg, abortSignal: controller.signal }),
      );
      try {
        await vi.waitFor(() => expect(getActiveBuzzBus("ada")).toBeDefined());
        await sendBuzzTyping({ cfg, to: CHANNEL_ID, threadId: "root-id" });
        expect(gatewayMocks.busSendTyping).toHaveBeenCalledWith({
          channelId: CHANNEL_ID,
          threadId: undefined,
        });
        gatewayMocks.busSendTyping.mockClear();
        if (disabledScope === "root") {
          cfg.channels!.buzz!.enabled = false;
        } else {
          cfg.channels!.buzz!.accounts!.ada.enabled = false;
        }
        await sendBuzzTyping({ cfg, to: CHANNEL_ID, threadId: "root-id" });
        expect(gatewayMocks.busSendTyping).not.toHaveBeenCalled();
      } finally {
        controller.abort();
        await lifecycle;
      }
    },
  );

  it("preserves room activation after a failed initial session", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    gatewayMocks.startBuzzBus.mockRejectedValueOnce(new Error("connect failed"));
    const { abortController, lifecycle } = startTestGateway();
    await vi.advanceTimersByTimeAsync(1_200);

    await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
    const firstSince = resolveBusSince(0);
    const secondSince = resolveBusSince(1);
    expect(secondSince).toBe(firstSince);

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

  it("preserves the activation floor on reconnect without trusting sender time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
      () => {},
    );
    const reconnectStartedAt = Math.floor(Date.now() / 1000);
    gatewayMocks.onFatalError?.(new Error("relay failed"));
    await vi.advanceTimersByTimeAsync(1_200);

    await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
    expect(invalidateDirectoryCache).toHaveBeenCalledTimes(2);
    const secondSince = resolveBusSince(1);
    expect(secondSince).toBe(resolveBusSince(0));
    expect(secondSince).toBeLessThanOrEqual(reconnectStartedAt);
    expect(secondSince).toBeLessThan(createdAt);

    abortController.abort();
    await expect(lifecycle).resolves.toBeUndefined();
  });
});
