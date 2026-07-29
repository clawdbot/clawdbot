// WhatsApp tests cover outbound retry behavior.
import { describe, expect, it, vi } from "vitest";
import { sendWhatsAppOutboundWithRetry } from "./outbound-retry.js";
import { withWhatsAppSocketOperationTimeout } from "./socket-timing.js";

async function runWithFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const promise = run();
    await vi.runAllTimersAsync();
    return await promise;
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
}

describe("sendWhatsAppOutboundWithRetry", () => {
  it.each([new Error("connection closed"), { code: "ECONNRESET" }])(
    "retries a directly retryable error",
    async (error) => {
      const send = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(error)
        .mockResolvedValue("ok");

      await expect(runWithFakeTimers(() => sendWhatsAppOutboundWithRetry({ send }))).resolves.toBe(
        "ok",
      );

      expect(send).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { name: "a non-retryable direct error", error: new Error("invalid recipient") },
    {
      name: "a retryable signal only in the cause",
      error: new Error("request failed", { cause: new Error("socket disconnected") }),
    },
  ])("does not retry $name", async ({ error }) => {
    const send = vi.fn<() => Promise<string>>().mockRejectedValue(error);
    const onRetry = vi.fn();

    const failure = await sendWhatsAppOutboundWithRetry({ send, onRetry }).catch(
      (caught: unknown) => caught,
    );

    expect(failure).toBe(error);
    expect(send).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("does not retry a direct unknown-delivery socket timeout", async () => {
    const send = vi
      .fn<() => Promise<string>>()
      .mockImplementation(
        async () =>
          await withWhatsAppSocketOperationTimeout(
            "sendMessage",
            new Promise<string>(() => {}),
            1_000,
          ),
      );
    const onRetry = vi.fn();

    const failure = await runWithFakeTimers(() =>
      sendWhatsAppOutboundWithRetry({ send, onRetry }).catch((caught: unknown) => caught),
    );

    expect(failure).toMatchObject({
      name: "WhatsAppSocketOperationTimeoutError",
      deliveryState: "unknown",
    });
    expect(send).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("preserves attempts, delays, callback fields, and terminal error identity", async () => {
    const firstError = {
      output: {
        statusCode: 503,
        payload: {
          statusCode: 503,
          error: "Service Unavailable",
          message: "connection closed",
        },
      },
    };
    const secondError = new Error("socket reset");
    const terminalError = { code: "ECONNRESET", marker: "terminal" };
    const send = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(secondError)
      .mockRejectedValueOnce(terminalError);
    const onRetry = vi.fn();

    const failure = await runWithFakeTimers(() =>
      sendWhatsAppOutboundWithRetry({ send, onRetry }).catch((caught: unknown) => caught),
    );

    expect(failure).toBe(terminalError);
    expect(send).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, {
      attempt: 1,
      maxAttempts: 3,
      backoffMs: 500,
      error: firstError,
      errorText: "status=503 Service Unavailable connection closed",
    });
    expect(onRetry).toHaveBeenNthCalledWith(2, {
      attempt: 2,
      maxAttempts: 3,
      backoffMs: 1_000,
      error: secondError,
      errorText: "socket reset",
    });
  });
});
