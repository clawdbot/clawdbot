/**
 * Transport-level coverage for the GPT-Live offer endpoint.
 *
 * A mocked response records a status even when the socket died first, so the
 * answered-then-released contract is only observable over a real socket.
 */
import { createServer, type Server } from "node:http";
import { postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENAI_QUICKSILVER_OFFER_PATH } from "./realtime-quicksilver-session.js";
import { createBroker } from "./realtime-quicksilver.test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function listenOnLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected the realtime offer test server to have a TCP address");
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe("GPT-Live offer transport", () => {
  it("delivers a rejected offer's response before releasing the connection", async () => {
    const { realtime } = createBroker();
    const server = createServer((req, res) => {
      void realtime.handler(req, res);
    });
    try {
      const port = await listenOnLoopback(server);
      const url = `http://127.0.0.1:${port}${OPENAI_QUICKSILVER_OFFER_PATH}`;
      // Offer credentials are single-use, so every request needs its own reservation.
      const offerHeaders = async (): Promise<Record<string, string>> => {
        const reservation = await realtime.broker.createBrowserSession(
          {
            providerConfig: {},
            model: "gpt-live-1",
            runAgentConsult: vi.fn(async () => ({ text: "Done" })),
          },
          { type: "api-key", token: "platform-key" },
        );
        if (reservation.transport !== "webrtc") {
          throw new Error("Expected WebRTC reservation");
        }
        return {
          authorization: `Bearer ${reservation.clientSecret}`,
          "content-type": "application/sdp",
        };
      };

      // Declared over-cap length: rejected from the header alone, while the browser is
      // still mid-upload and can only learn the outcome from what reaches it.
      const declared = await postRawWebhook({
        url,
        body: "v=offer",
        contentLength: 300 * 1024,
        headers: await offerHeaders(),
        idleTimeoutMs: 500,
      });
      expect(declared.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
      expect(declared.body).toBe("Payload too large");
      expect(declared.closedByServer).toBe(true);

      // Chunked, so there is no declared length and the cap can only be hit by counting
      // the bytes that actually arrive.
      const streamed = await postRawWebhook({
        url,
        body: "v".repeat(300 * 1024),
        headers: await offerHeaders(),
        chunkedEncoding: true,
        chunk: { bytes: 32 * 1024, intervalMs: 5 },
        idleTimeoutMs: 500,
      });
      expect(streamed.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
      expect(streamed.closedByServer).toBe(true);

      // Control: an under-cap offer is still read and answered on a retained connection,
      // so the teardown above is attributable to the rejection, not to every offer.
      const withinCap = await postRawWebhook({
        url,
        body: "   ",
        headers: await offerHeaders(),
        idleTimeoutMs: 500,
      });
      expect(withinCap.statusLine).toBe("HTTP/1.1 400 Bad Request");
      expect(withinCap.body).toContain("SDP offer is required");
      expect(withinCap.closedByServer).toBe(false);
    } finally {
      await closeServer(server);
      await realtime.cleanup();
    }
  });
});
