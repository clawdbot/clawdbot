// Nextcloud Talk monitor shutdown tests cover composite abort ownership.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { describe, expect, it, vi } from "vitest";
import { monitorNextcloudTalkProvider } from "./monitor-runtime.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { NextcloudTalkInboundMessage } from "./types.js";

describe("Nextcloud Talk monitor abort", () => {
  it("stops both the webhook listener and durable spool after startup", async () => {
    setNextcloudTalkRuntime(createPluginRuntimeMock() as unknown as PluginRuntime);
    const abortController = new AbortController();
    const serverStop = vi.fn(async () => {});
    const spoolStop = vi.fn(async () => {});
    const statusSink = vi.fn();
    const createSpool = vi.fn(() => ({
      receive: vi.fn(async () => "accepted" as const),
      ready: vi.fn(async () => {}),
      stop: spoolStop,
      waitForIdle: vi.fn(async () => {}),
    }));
    const createServer = vi.fn(() => ({
      server: {} as never,
      start: vi.fn(async () => {}),
      stop: serverStop,
    }));
    const monitor = await monitorNextcloudTalkProvider({
      config: {
        gateway: {
          trustedProxies: ["127.0.0.1"],
          allowRealIpFallback: true,
        },
        channels: {
          "nextcloud-talk": {
            baseUrl: "https://cloud.example.com",
            botSecret: "test-bot-secret",
          },
        },
      },
      runtime: { error: vi.fn(), log: vi.fn(), exit: vi.fn() as never },
      abortSignal: abortController.signal,
      statusSink,
      createSpool,
      createServer,
    });

    expect(createSpool).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: abortController.signal }),
    );
    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        trustedProxies: ["127.0.0.1"],
        allowRealIpFallback: true,
      }),
    );
    expect(statusSink).toHaveBeenCalledExactlyOnceWith({
      running: true,
      connected: true,
      lifecycle: "ready",
      lastConnectedAt: expect.any(Number),
      lastError: null,
      terminalDisconnect: undefined,
    });
    abortController.abort();
    await vi.waitFor(() => expect(spoolStop).toHaveBeenCalledOnce());
    await monitor.stop();

    expect(serverStop).toHaveBeenCalledOnce();
    expect(spoolStop).toHaveBeenCalledOnce();
  });

  it("does not publish ready when startup is aborted after the listener opens", async () => {
    setNextcloudTalkRuntime(createPluginRuntimeMock() as unknown as PluginRuntime);
    const abortController = new AbortController();
    const statusSink = vi.fn();
    const serverStop = vi.fn(async () => {});
    const spoolStop = vi.fn(async () => {});

    await monitorNextcloudTalkProvider({
      config: {
        channels: {
          "nextcloud-talk": {
            baseUrl: "https://cloud.example.com",
            botSecret: "test-bot-secret",
          },
        },
      },
      runtime: { error: vi.fn(), log: vi.fn(), exit: vi.fn() as never },
      abortSignal: abortController.signal,
      statusSink,
      createSpool: () => ({
        receive: vi.fn(async () => "accepted" as const),
        ready: vi.fn(async () => {}),
        stop: spoolStop,
        waitForIdle: vi.fn(async () => {}),
      }),
      createServer: () => ({
        server: {} as never,
        start: vi.fn(async () => abortController.abort()),
        stop: serverStop,
      }),
    });

    expect(statusSink).not.toHaveBeenCalled();
    expect(serverStop).toHaveBeenCalledOnce();
    expect(spoolStop).toHaveBeenCalledOnce();
  });

  it("returns retryable monitor delivery results to the durable spool", async () => {
    setNextcloudTalkRuntime(createPluginRuntimeMock() as unknown as PluginRuntime);
    const expectedError = new Error("room lookup unavailable");
    const expectedResult = { kind: "failed-retryable" as const, error: expectedError };
    let deliver:
      | Parameters<
          NonNullable<Parameters<typeof monitorNextcloudTalkProvider>[0]["createSpool"]>
        >[0]["deliver"]
      | undefined;
    const createSpool = vi.fn((options) => {
      deliver = options.deliver;
      return {
        receive: vi.fn(async () => "accepted" as const),
        ready: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        waitForIdle: vi.fn(async () => {}),
      };
    });
    const createServer = vi.fn(() => ({
      server: {} as never,
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    }));

    const monitor = await monitorNextcloudTalkProvider({
      config: {
        channels: {
          "nextcloud-talk": {
            baseUrl: "https://cloud.example.com",
            botSecret: "test-bot-secret",
          },
        },
      },
      runtime: { error: vi.fn(), log: vi.fn(), exit: vi.fn() as never },
      createSpool,
      createServer,
      onMessage: vi.fn(async () => expectedResult),
    });

    const message: NextcloudTalkInboundMessage = {
      messageId: "msg-retry",
      roomToken: "room-direct",
      roomName: "Direct room",
      senderId: "user-1",
      senderName: "Alice",
      text: "hello",
      mediaType: "text/plain",
      timestamp: 1_700_000_000_000,
      isGroupChat: true,
    };
    const lifecycle = {
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(async () => {}),
      onDeferred: vi.fn(),
      onAdoptionFinalizing: vi.fn(),
      onAbandoned: vi.fn(async () => {}),
    };

    await expect(deliver?.(message, lifecycle)).resolves.toBe(expectedResult);
    await monitor.stop();
  });
});
