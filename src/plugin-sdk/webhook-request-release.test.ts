/**
 * Tests that a caller-answered webhook rejection reaches the sender before release.
 */
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { isRequestBodyLimitError, requestBodyErrorToText } from "../infra/http-body.js";
import { postRawWebhook } from "./test-helpers/raw-http-request.js";
import { readWebhookBodyForResponse } from "./webhook-request-release.js";

const MAX_BYTES = 32 * 1024;

async function withCallerAnsweredServer(
  run: (baseUrl: string) => Promise<void>,
  options?: { timeoutMs?: number },
): Promise<void> {
  const server = createServer((req, res) => {
    void readWebhookBodyForResponse(req, res, {
      maxBytes: MAX_BYTES,
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
      .then(() => {
        res.statusCode = 200;
        res.end("ok");
      })
      .catch((error: unknown) => {
        // The helper never answers on its own; this envelope is the caller's own.
        if (!isRequestBodyLimitError(error)) {
          res.statusCode = 500;
          res.end("boom");
          return;
        }
        res.statusCode = error.statusCode;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: requestBodyErrorToText(error.code) }));
      });
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
      throw new Error("expected release test server to have a TCP address");
    }
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

describe("readWebhookBodyForResponse over a real socket", () => {
  it("delivers the caller's 413 when the whole over-limit body arrives in one write", async () => {
    // Single-write uploads are the regressed shape: destroying the request races the flush,
    // so the sender sees an empty status line instead of the envelope the caller chose.
    await withCallerAnsweredServer(async (baseUrl) => {
      const rejected = await postRawWebhook({
        url: `${baseUrl}/hook`,
        body: "x".repeat(MAX_BYTES * 2),
        headers: { "content-type": "application/json" },
      });

      expect(rejected.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
      expect(rejected.body).toContain("too large");
      expect(rejected.closedByServer).toBe(true);

      // Control: the same path under the cap still reaches the handler, so the rejection
      // above is attributable to the byte count rather than to the release itself.
      const accepted = await postRawWebhook({
        url: `${baseUrl}/hook`,
        body: "x".repeat(1024),
        headers: { "content-type": "application/json" },
      });
      expect(accepted.statusLine).toBe("HTTP/1.1 200 OK");
    });
  });

  it("delivers the caller's 408 when the sender stalls mid-upload", async () => {
    await withCallerAnsweredServer(
      async (baseUrl) => {
        const stalled = await postRawWebhook({
          url: `${baseUrl}/hook`,
          body: "y".repeat(MAX_BYTES / 2),
          headers: { "content-type": "application/json" },
          chunkedEncoding: true,
          chunk: { bytes: 256, intervalMs: 400 },
        });

        expect(stalled.statusLine).toBe("HTTP/1.1 408 Request Timeout");
        expect(stalled.closedByServer).toBe(true);
      },
      { timeoutMs: 150 },
    );
  });
});
