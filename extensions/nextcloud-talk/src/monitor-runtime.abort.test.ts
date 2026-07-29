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
        channels: {
          "nextcloud-talk": {
            baseUrl: "https://cloud.example.com",
            botSecret: "test-bot-secret",
          },
        },
      },
      runtime: { error: vi.fn(), log: vi.fn(), exit: vi.fn() as never },
      abortSignal: abortController.signal,
      createSpool,
      createServer,
    });

    expect(createSpool).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: abortController.signal }),
    );
    abortController.abort();
    await vi.waitFor(() => expect(spoolStop).toHaveBeenCalledOnce());
    await monitor.stop();

    expect(serverStop).toHaveBeenCalledOnce();
    expect(spoolStop).toHaveBeenCalledOnce();
  });
});
