// Line tests cover webhook body-limit answers as the sender receives them on the wire.
import crypto from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { monitorLineProvider } from "./monitor.js";

type LineNodeWebhookHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const { createLineBotMock, registerWebhookTargetWithPluginRouteMock } = vi.hoisted(() => ({
  createLineBotMock: vi.fn(),
  registerWebhookTargetWithPluginRouteMock: vi.fn(),
}));

vi.mock("./bot.js", () => ({ createLineBot: createLineBotMock }));

vi.mock("openclaw/plugin-sdk/webhook-ingress", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/webhook-ingress")>(
    "openclaw/plugin-sdk/webhook-ingress",
  );
  return {
    ...actual,
    normalizePluginHttpPath: (path: string | undefined, fallback: string) => path ?? fallback,
    registerWebhookTargetWithPluginRoute: registerWebhookTargetWithPluginRouteMock,
  };
});

function requireRegisteredHandler(): LineNodeWebhookHandler {
  const registration = registerWebhookTargetWithPluginRouteMock.mock.calls[0]?.[0] as
    | { route?: { handler?: LineNodeWebhookHandler } }
    | undefined;
  const handler = registration?.route?.handler;
  if (!handler) {
    throw new Error("expected registered LINE webhook route");
  }
  return handler;
}

function signLineWebhook(body: string): string {
  return crypto.createHmac("SHA256", "secret").update(body).digest("base64");
}

describe("monitorLineProvider webhook body limits over a real connection", () => {
  beforeEach(() => {
    createLineBotMock.mockReset().mockImplementation(() => ({
      account: { accountId: "default" },
      handleWebhook: vi.fn(async () => "durable" as const),
      stop: vi.fn(async () => undefined),
    }));
    // The monitor matches an inbound signature against the targets it registered, so the
    // registration seam has to keep that map for the accepted case to reach an account.
    registerWebhookTargetWithPluginRouteMock.mockReset().mockImplementation((params) => {
      const key = params.target.path.toLowerCase();
      const normalizedTarget = { ...params.target, path: key };
      params.targetsByPath.set(key, [...(params.targetsByPath.get(key) ?? []), normalizedTarget]);
      return {
        target: normalizedTarget,
        unregister: () => params.targetsByPath.delete(key),
      };
    });
  });

  afterAll(() => {
    vi.doUnmock("./bot.js");
    vi.doUnmock("openclaw/plugin-sdk/webhook-ingress");
    vi.resetModules();
  });

  // A real socket is the only place both halves of the contract are observable: the handler
  // answers while the sender is still uploading, and then closes the connection.
  const withLineWebhookWire = async (run: (webhookUrl: string) => Promise<void>) => {
    const monitor = await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      accountId: "default",
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });
    const handler = requireRegisteredHandler();
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
        throw new Error("expected LINE webhook test server to have a TCP address");
      }
      await run(`http://127.0.0.1:${address.port}/line/webhook`);
    } finally {
      try {
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      } finally {
        await monitor.stop();
      }
    }
  };

  it("answers an over-limit webhook with 413 and then closes the connection", async () => {
    await withLineWebhookWire(async (webhookUrl) => {
      const oversizedPayload = JSON.stringify({
        events: [{ type: "message" }],
        padding: "x".repeat(70 * 1024),
      });
      const oversized = await postRawWebhook({
        url: webhookUrl,
        body: oversizedPayload,
        headers: {
          "content-type": "application/json",
          "x-line-signature": signLineWebhook(oversizedPayload),
        },
      });
      expect(oversized.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
      expect(JSON.parse(oversized.body)).toEqual({ error: "Payload too large" });
      expect(oversized.closedByServer).toBe(true);

      // Same route: an in-limit webhook is still admitted and answered normally.
      const acceptedPayload = JSON.stringify({ events: [{ type: "message" }] });
      const accepted = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-line-signature": signLineWebhook(acceptedPayload),
        },
        body: acceptedPayload,
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ status: "ok" });
    });
  });

  it("counts UTF-8 bytes, not characters, for a chunked non-ASCII webhook", async () => {
    // LINE payloads are routinely non-ASCII, and chunk sizes are byte counts. Sending the
    // framing and the body as one string would re-encode every byte above 0x7f after the
    // declared length was computed, so the under-cap control below only reaches the handler
    // when the driver is byte-exact.
    await withLineWebhookWire(async (webhookUrl) => {
      // 30,000 characters is well under the 65,536-byte cap as characters, and well over it
      // as UTF-8. A character-counting limit would admit this body.
      const overCap = JSON.stringify({
        events: [{ type: "message" }],
        padding: "壓".repeat(30_000),
      });
      expect(overCap.length).toBeLessThan(64 * 1024);
      expect(Buffer.byteLength(overCap, "utf-8")).toBeGreaterThan(64 * 1024);
      const rejected = await postRawWebhook({
        url: webhookUrl,
        body: overCap,
        chunkedEncoding: true,
        chunk: { bytes: 8 * 1024, intervalMs: 1 },
        headers: {
          "content-type": "application/json",
          "x-line-signature": signLineWebhook(overCap),
        },
      });
      expect(rejected.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
      expect(JSON.parse(rejected.body)).toEqual({ error: "Payload too large" });
      expect(rejected.closedByServer).toBe(true);

      // Control: the same non-ASCII chunked shape under the cap is signed, parsed, and
      // answered, so the rejection above is attributable to the byte count rather than to
      // chunked framing the server could not read.
      const underCap = JSON.stringify({
        events: [{ type: "message" }],
        padding: "壓".repeat(1_000),
      });
      const accepted = await postRawWebhook({
        url: webhookUrl,
        body: underCap,
        chunkedEncoding: true,
        chunk: { bytes: 1024, intervalMs: 1 },
        headers: {
          "content-type": "application/json",
          "x-line-signature": signLineWebhook(underCap),
        },
      });
      expect(accepted.statusLine).toBe("HTTP/1.1 200 OK");
      expect(JSON.parse(accepted.body)).toEqual({ status: "ok" });
    });
  });
});
