import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DISCORD_REST_TIMEOUT_MS } from "./proxy-request-client.js";
import { sendWebhookMessageDiscord } from "./send.webhook.js";

const opts = {
  cfg: { channels: { discord: { token: "Bot test-token" } } } as OpenClawConfig,
  webhookId: "1",
  webhookToken: "token",
  wait: true as const,
};

function requireSignal(init: RequestInit | undefined): AbortSignal {
  const signal = init?.signal;
  if (!signal) {
    throw new Error("expected Discord webhook request signal");
  }
  return signal;
}

function requireAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("request aborted");
}

function rejectOnAbort(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const rejectWithReason = () => reject(requireAbortError(signal));
    if (signal.aborted) {
      rejectWithReason();
      return;
    }
    signal.addEventListener("abort", rejectWithReason, { once: true });
  });
}

function bodyThatErrorsOnAbort(signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const errorWithReason = () => controller.error(requireAbortError(signal));
      if (signal.aborted) {
        errorWithReason();
        return;
      }
      signal.addEventListener("abort", errorWithReason, { once: true });
    },
  });
}

async function expectWebhookTimeout(promise: Promise<unknown>): Promise<void> {
  const rejection = expect(promise).rejects.toMatchObject({
    name: "TimeoutError",
    message: "request timed out",
  });
  await Promise.all([vi.advanceTimersByTimeAsync(DISCORD_REST_TIMEOUT_MS), rejection]);
}

describe("sendWebhookMessageDiscord timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts when Discord never returns response headers", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>((_input, init) => rejectOnAbort(requireSignal(init)));
    vi.stubGlobal("fetch", fetchMock);

    await expectWebhookTimeout(sendWebhookMessageDiscord("hello", opts));

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "success", status: 200 },
    { label: "error", status: 503 },
  ])("keeps the deadline active through a stalled $label body", async ({ status }) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = requireSignal(init);
      return new Response(bodyThatErrorsOnAbort(signal), { status });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expectWebhookTimeout(sendWebhookMessageDiscord("hello", opts));
  });

  it("cleans up the deadline after a normal response", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        return new Response(JSON.stringify({ id: "message-1", channel_id: "channel-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await expect(sendWebhookMessageDiscord("hello", opts)).resolves.toMatchObject({
      messageId: "message-1",
      channelId: "channel-1",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
