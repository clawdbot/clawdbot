import { once } from "node:events";
// Loopback proof: dripping generated-music bodies cannot outlive the download deadline.
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { readResponseWithLimit } from "../infra/http-body.js";
import { downloadGeneratedMusicAsset } from "./provider-assets.js";

describe("downloadGeneratedMusicAsset", () => {
  let server: http.Server | undefined;
  const dripTimers = new Set<ReturnType<typeof setTimeout>>();

  afterEach(async () => {
    for (const timer of dripTimers) {
      clearTimeout(timer);
    }
    dripTimers.clear();
    if (!server) {
      return;
    }
    server.closeAllConnections?.();
    server.close();
    await once(server, "close").catch(() => undefined);
    server = undefined;
  });

  async function listenDripServer(params: {
    statusCode: number;
    contentType: string;
    chunk: Buffer | string;
  }): Promise<number> {
    server = http.createServer((_req, res) => {
      res.on("error", () => {});
      res.writeHead(params.statusCode, {
        "Content-Type": params.contentType,
        "Transfer-Encoding": "chunked",
      });
      // Keep sending bytes so chunk idle alone would never fire.
      const drip = () => {
        if (res.writableEnded || res.destroyed) {
          return;
        }
        res.write(params.chunk);
        const timer = setTimeout(drip, 20);
        dripTimers.add(timer);
      };
      drip();
    });
    server.on("clientError", (_err, socket) => socket.destroy());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }
    return address.port;
  }

  it("bounds a dripping download body with one wall-clock deadline", async () => {
    const timeoutMs = 250;
    const port = await listenDripServer({
      statusCode: 200,
      contentType: "audio/mpeg",
      chunk: Buffer.from([0x00]),
    });

    const startedAt = performance.now();
    await expect(
      downloadGeneratedMusicAsset({
        candidate: { url: `http://127.0.0.1:${port}/generated/track.mp3` },
        timeoutMs,
        fetchFn: fetch,
        provider: "fal",
        requestFailedMessage: "fal generated music download failed",
        maxBytes: 1024 * 1024,
      }),
    ).rejects.toThrow(`fal generated music download timed out after ${timeoutMs}ms`);
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 50);
    expect(elapsedMs).toBeLessThan(timeoutMs + 1_500);
  });

  it("throws on non-2xx HTTP status without retry", async () => {
    // 400 is explicitly non-retryable. Use an immediate response so the HTTP
    // status error is thrown directly — no body-read timeout to confuse retry.
    server = http.createServer((_req, res) => {
      res.on("error", () => {});
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected port");
    }

    await expect(
      downloadGeneratedMusicAsset({
        candidate: { url: `http://127.0.0.1:${address.port}/generated/track.mp3` },
        timeoutMs: 5000,
        fetchFn: fetch,
        provider: "fal",
        requestFailedMessage: "fal generated music download failed",
        maxBytes: 1024 * 1024,
      }),
    ).rejects.toThrow("fal generated music download failed (HTTP 400): Bad Request");
  });

  it("retries on transient HTTP status before succeeding", async () => {
    let requestCount = 0;

    server = http.createServer((_req, res) => {
      res.on("error", () => {});
      requestCount += 1;
      if (requestCount === 1) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("Service Unavailable");
      } else {
        res.writeHead(200, { "Content-Type": "audio/mpeg" });
        res.end(Buffer.alloc(1024, 0x00));
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected port");
    }

    const result = await downloadGeneratedMusicAsset({
      candidate: { url: `http://127.0.0.1:${address.port}/track.mp3` },
      timeoutMs: 5000,
      fetchFn: fetch,
      provider: "test-provider",
      requestFailedMessage: "test music download failed",
      maxBytes: 1024 * 1024,
    });

    expect(requestCount).toBe(2);
    expect(result.buffer.length).toBe(1024);
    expect(result.mimeType).toBe("audio/mpeg");
  });

  it("skips diagnostic body read on retryable status so deadline survives for retry", async () => {
    // A dripping 503 body would consume the wall-clock deadline if read for
    // diagnostics. The fix cancels the body immediately for retryable 5xx
    // statuses so the retry gets a usable budget.
    let requestCount = 0;

    server = http.createServer((_req, res) => {
      res.on("error", () => {});
      requestCount += 1;
      if (requestCount === 1) {
        res.writeHead(503, {
          "Content-Type": "text/plain",
          "Transfer-Encoding": "chunked",
        });
        // Drip bytes forever so a body read would consume the full deadline.
        const drip = () => {
          if (res.writableEnded || res.destroyed) {
            return;
          }
          res.write("e");
          dripTimers.add(setTimeout(drip, 15));
        };
        drip();
      } else {
        res.writeHead(200, { "Content-Type": "audio/mpeg" });
        res.end(Buffer.alloc(1024, 0x00));
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected port");
    }

    const startedAt = performance.now();
    const result = await downloadGeneratedMusicAsset({
      candidate: { url: `http://127.0.0.1:${address.port}/track.mp3` },
      timeoutMs: 5000,
      fetchFn: fetch,
      provider: "test-provider",
      requestFailedMessage: "test music download failed",
      maxBytes: 1024 * 1024,
    });
    const elapsedMs = performance.now() - startedAt;

    // The 503 body was cancelled immediately (not read), so the retry
    // happens quickly — well within the timeout budget.
    expect(requestCount).toBe(2);
    expect(result.buffer.length).toBe(1024);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("does not bound a dripping body when only chunk idle timeout is used", async () => {
    // Negative control: chunkTimeoutMs resets on every drip, so idle alone never fires.
    server = http.createServer((_req, res) => {
      res.on("error", () => {});
      res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Transfer-Encoding": "chunked",
      });
      const drip = () => {
        if (res.writableEnded || res.destroyed) {
          return;
        }
        res.write(Buffer.from([0x00]));
        const timer = setTimeout(drip, 20);
        dripTimers.add(timer);
      };
      drip();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    let settled = false;
    void readResponseWithLimit(response, 1024 * 1024, {
      chunkTimeoutMs: 100,
      onIdleTimeout: ({ chunkTimeoutMs }) => new Error(`idle fired after ${chunkTimeoutMs}ms`),
    })
      .then(() => {
        settled = true;
      })
      .catch(() => {
        settled = true;
      });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 400);
    });
    expect(settled).toBe(false);
    // Body reader is locked by readResponseWithLimit; tear down via server close in afterEach.
  });
});
