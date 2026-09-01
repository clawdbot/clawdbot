// Twitch tests cover client manager registry plugin behavior.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getClientManager,
  getOrCreateClientManager,
  removeClientManager,
} from "./client-manager-registry.js";
import { sendMessageTwitchInternal } from "./send.js";
import { BASE_TWITCH_TEST_ACCOUNT, makeTwitchTestConfig } from "./test-fixtures.js";
import type { ChannelLogSink, TwitchAccountConfig } from "./types.js";

function makeLogger(): ChannelLogSink {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

const account = {
  ...BASE_TWITCH_TEST_ACCOUNT,
  accessToken: "oauth:test-token",
  enabled: true,
} satisfies TwitchAccountConfig;

function attachFakeTransport(manager: ReturnType<typeof getOrCreateClientManager>) {
  const transport = {
    quit: vi.fn(),
    say: vi.fn((_channel: string, _message: string) => Promise.resolve()),
  };
  const state = manager as unknown as {
    clients: Map<string, typeof transport>;
    messageHandlers: Map<string, unknown>;
  };
  state.clients.set(manager.getAccountKey(account), transport);
  manager.onMessage(account, vi.fn());
  return { state, transport };
}

describe("client manager registry", () => {
  afterEach(async () => {
    await removeClientManager("default");
  });

  it.each(["resolves", "rejects"] as const)(
    "retires managers immediately and preserves replacements when cleanup %s",
    async (outcome) => {
      const logger = makeLogger();
      const firstManager = getOrCreateClientManager("default", logger);
      const { state, transport } = attachFakeTransport(firstManager);
      const cleanup = createDeferred<void>();
      const disconnect = firstManager.disconnectAll.bind(firstManager);
      const disconnectAll = vi.spyOn(firstManager, "disconnectAll").mockImplementation(async () => {
        await disconnect();
        await cleanup.promise;
      });
      const unregisterMessage = "Unregistered client manager for account: default";
      const removal = removeClientManager("default");

      try {
        expect(disconnectAll).toHaveBeenCalledOnce();
        expect(transport.quit).toHaveBeenCalledOnce();
        expect(state.clients.size).toBe(0);
        expect(state.messageHandlers.size).toBe(0);
        expect(getClientManager("default")).toBeUndefined();
        expect(logger.info).not.toHaveBeenCalledWith(unregisterMessage);

        const replacement = getOrCreateClientManager("default", makeLogger());
        expect(replacement).not.toBe(firstManager);

        if (outcome === "rejects") {
          const disconnectError = new Error("disconnect failed");
          const rejected = expect(removal).rejects.toBe(disconnectError);
          cleanup.reject(disconnectError);
          await rejected;
        } else {
          cleanup.resolve();
          await expect(removal).resolves.toBeUndefined();
        }

        expect(getClientManager("default")).toBe(replacement);
        expect(logger.info).toHaveBeenCalledWith(unregisterMessage);
      } finally {
        cleanup.resolve();
        await removal.catch(() => undefined);
      }
    },
  );

  it("keeps outbound delivery off a retired manager and sends through its replacement", async () => {
    const logger = makeLogger();
    const firstManager = getOrCreateClientManager("default", logger);
    const first = attachFakeTransport(firstManager);
    const cleanup = createDeferred<void>();
    const disconnect = firstManager.disconnectAll.bind(firstManager);
    vi.spyOn(firstManager, "disconnectAll").mockImplementation(async () => {
      await disconnect();
      await cleanup.promise;
    });
    const getClient = firstManager.getClient.bind(firstManager);
    const reconnect = vi.spyOn(firstManager, "getClient").mockImplementation(async (...args) => {
      first.state.clients.set(firstManager.getAccountKey(account), first.transport);
      return await getClient(...args);
    });
    const config = makeTwitchTestConfig(account);
    const removal = removeClientManager("default");

    try {
      const whileRetiring = await sendMessageTwitchInternal(
        "#testchannel",
        "while retiring",
        config,
        "default",
        false,
      );

      expect(whileRetiring).toMatchObject({
        ok: false,
        error:
          "Client manager not found for account: default. Please start the Twitch gateway first.",
      });
      expect(reconnect).not.toHaveBeenCalled();
      expect(first.transport.say).not.toHaveBeenCalled();

      const replacement = getOrCreateClientManager("default", makeLogger());
      const { transport } = attachFakeTransport(replacement);
      const afterRestart = await sendMessageTwitchInternal(
        "#testchannel",
        "after restart",
        config,
        "default",
        false,
      );

      expect(afterRestart.ok).toBe(true);
      expect(transport.say).toHaveBeenCalledWith("testchannel", "after restart");

      cleanup.resolve();
      await expect(removal).resolves.toBeUndefined();
      expect(getClientManager("default")).toBe(replacement);
    } finally {
      cleanup.resolve();
      await removal.catch(() => undefined);
    }
  });
});
