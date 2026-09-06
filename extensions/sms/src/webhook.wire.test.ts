// Sms tests cover webhook responses as the sender receives them on the wire.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { postRawWebhook, withServer } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSmsWebhookHandler } from "./webhook.js";
import {
  advanceSmsTestAccountId,
  createSmsTestAccount,
  createSmsTestDeliveryRecorder,
} from "./webhook.test-support.js";

vi.mock("node:timers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers")>();
  return {
    ...actual,
    setTimeout: ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      globalThis.setTimeout(callback, delay, ...args)) as typeof actual.setTimeout,
    clearTimeout: ((timer: ReturnType<typeof globalThis.setTimeout> | undefined) =>
      globalThis.clearTimeout(timer)) as typeof actual.clearTimeout,
  };
});

const assertSmsCredentialOwnerAvailable = vi.hoisted(() => vi.fn());
const enqueueSmsIngress = vi.hoisted(() =>
  vi.fn(async () => ({ kind: "accepted" as const, duplicate: false })),
);

vi.mock("./credential-availability.js", () => ({ assertSmsCredentialOwnerAvailable }));

describe("createSmsWebhookHandler over a real connection", () => {
  beforeEach(() => {
    assertSmsCredentialOwnerAvailable.mockReset();
    enqueueSmsIngress.mockReset();
    enqueueSmsIngress.mockResolvedValue({ kind: "accepted", duplicate: false });
    advanceSmsTestAccountId();
  });

  it("delivers HTTP 413 over the wire and closes for an oversized callback body", async () => {
    const delivery = createSmsTestDeliveryRecorder();
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createSmsTestAccount(),
      ingress: { enqueue: enqueueSmsIngress },
      delivery,
    });
    await withServer(
      (req, res) => {
        void handler(req, res);
      },
      async (baseUrl) => {
        // Declared and sent in one write: the shape whose rejection used to race the flush.
        const result = await postRawWebhook({
          url: `${baseUrl}/sms`,
          body: "x".repeat(32 * 1024 + 1),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-twilio-signature": "unused",
          },
        });

        expect(result.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
        expect(result.headers.connection).toBe("close");
        expect(result.body).toBe("Payload too large");
        expect(result.closedByServer).toBe(true);
        expect(delivery.record).not.toHaveBeenCalled();
        expect(enqueueSmsIngress).not.toHaveBeenCalled();
      },
    );
  });

  it("delivers a retryable 500 before closing a timed-out callback upload", async () => {
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createSmsTestAccount(),
      ingress: { enqueue: enqueueSmsIngress },
    });
    let routeError: unknown;
    const requestReceived = createDeferred<void>();
    await withServer(
      (req, res) => {
        void handler(req, res).catch((error: unknown) => {
          routeError = error;
          res.statusCode = 500;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("Internal Server Error");
        });
        // Observe after the body reader is installed; Bun's socket wrapper omits raw data events.
        req.once("data", () => requestReceived.resolve());
      },
      async (baseUrl) => {
        vi.useFakeTimers();
        try {
          const resultPromise = postRawWebhook({
            url: `${baseUrl}/sms`,
            body: "x",
            contentLength: 2,
            idleTimeoutMs: 10_000,
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "x-twilio-signature": "unused",
            },
          });

          await requestReceived.promise;
          await vi.advanceTimersByTimeAsync(6_000);
          const result = await resultPromise;

          expect(routeError).toBeUndefined();
          expect(result.statusLine).toBe("HTTP/1.1 500 Internal Server Error");
          expect(result.headers.connection).toBe("close");
          expect(result.body).toBe("Internal Server Error");
          expect(result.closedByServer).toBe(true);
          expect(enqueueSmsIngress).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      },
    );
  });
});
