// Nextcloud Talk plugin module implements monitor limiter lifecycle behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNextcloudTalkWebhookServer } from "./monitor.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Nextcloud Talk webhook auth rate limiter lifecycle", () => {
  it("releases the limiter prune timer on stop", async () => {
    vi.useFakeTimers();
    const baselineTimerCount = vi.getTimerCount();
    const handle = createNextcloudTalkWebhookServer({
      port: 0,
      host: "127.0.0.1",
      path: "/w",
      secret: "s",
      onWebhook: async () => "ignored",
    });
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 1);

    await handle.stop();

    expect(vi.getTimerCount()).toBe(baselineTimerCount);
  });

  it("keeps stop idempotent for the limiter timer", async () => {
    vi.useFakeTimers();
    const baselineTimerCount = vi.getTimerCount();
    const handle = createNextcloudTalkWebhookServer({
      port: 0,
      host: "127.0.0.1",
      path: "/w",
      secret: "s",
      onWebhook: async () => "ignored",
    });
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 1);

    await handle.stop();
    await handle.stop();

    expect(vi.getTimerCount()).toBe(baselineTimerCount);
  });
});
