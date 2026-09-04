// Nextcloud Talk monitor shutdown tests cover composite abort ownership.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { describe, expect, it, vi } from "vitest";
import { monitorNextcloudTalkProvider } from "./monitor-runtime.js";
import { setNextcloudTalkRuntime } from "./runtime.js";

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
});
