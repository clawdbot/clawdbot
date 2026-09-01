// Sms tests cover webhook responses as the sender receives them on the wire.
import { createServer } from "node:http";
import { postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSmsWebhookHandler } from "./webhook.js";
import {
  advanceSmsTestAccountId,
  createSmsTestAccount,
  createSmsTestDeliveryRecorder,
} from "./webhook.test-support.js";

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
    const server = createServer((req, res) => {
      void handler(req, res);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected the SMS webhook test server to have a TCP address");
      }

      // Declared and sent in one write: the shape whose rejection used to race the flush.
      const result = await postRawWebhook({
        url: `http://127.0.0.1:${address.port}/sms`,
        body: "x".repeat(32 * 1024 + 1),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": "unused",
        },
      });

      expect(result.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
      expect(result.body).toBe("Payload too large");
      expect(result.closedByServer).toBe(true);
      expect(delivery.record).not.toHaveBeenCalled();
      expect(enqueueSmsIngress).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
