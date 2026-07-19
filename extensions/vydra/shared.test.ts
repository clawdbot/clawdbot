// Vydra tests cover shared download timeout plugin behavior.
import { once } from "node:events";
import http from "node:http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { downloadVydraAsset } from "./shared.js";

describe("downloadVydraAsset", () => {
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
      contentType: "image/png",
      chunk: Buffer.from([0x00]),
    });

    const startedAt = performance.now();
    await expect(
      downloadVydraAsset({
        url: `http://127.0.0.1:${port}/generated/test.png`,
        kind: "image",
        timeoutMs,
        fetchFn: fetch,
        maxBytes: 1024 * 1024,
      }),
    ).rejects.toThrow(`Vydra image download timed out after ${timeoutMs}ms`);
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 50);
    expect(elapsedMs).toBeLessThan(timeoutMs + 1_500);
  });

  it("bounds a dripping non-2xx error body with one wall-clock deadline", async () => {
    const timeoutMs = 250;
    const port = await listenDripServer({
      statusCode: 500,
      contentType: "text/plain",
      chunk: "e",
    });

    const startedAt = performance.now();
    await expect(
      downloadVydraAsset({
        url: `http://127.0.0.1:${port}/generated/test.png`,
        kind: "image",
        timeoutMs,
        fetchFn: fetch,
        maxBytes: 1024 * 1024,
      }),
    ).rejects.toThrow(`Vydra image download timed out after ${timeoutMs}ms`);
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 50);
    expect(elapsedMs).toBeLessThan(timeoutMs + 1_500);
  });

  it("preserves normalized and redacted provider errors after the bounded read", async () => {
    const result = await downloadVydraAsset({
      url: "https://cdn.vydra.example/generated/test.png",
      kind: "image",
      timeoutMs: 250,
      fetchFn: async () =>
        new Response(
          JSON.stringify({ message: "Authorization: Bearer test-token", code: "asset_failed" }),
          {
            status: 502,
            headers: { "x-request-id": "req-vydra-test" },
          },
        ),
      maxBytes: 1024 * 1024,
    }).catch((error: unknown) => error);

    expect(result).toMatchObject({
      name: "ProviderHttpError",
      status: 502,
      statusCode: 502,
      errorCode: "asset_failed",
      requestId: "req-vydra-test",
    });
    expect(result).toBeInstanceOf(Error);
    expect(result instanceof Error ? result.message : "").not.toContain("test-token");
  });

  it("normalizes null-body HTTP errors after the bounded read", async () => {
    const result = await downloadVydraAsset({
      url: "https://cdn.vydra.example/generated/test.png",
      kind: "image",
      timeoutMs: 250,
      fetchFn: async () => new Response(null, { status: 304 }),
      maxBytes: 1024 * 1024,
    }).catch((error: unknown) => error);

    expect(result).toMatchObject({ name: "ProviderHttpError", status: 304, statusCode: 304 });
  });

  it("preserves HTTP metadata when the error body stream fails", async () => {
    const result = await downloadVydraAsset({
      url: "https://cdn.vydra.example/generated/test.png",
      kind: "image",
      timeoutMs: 250,
      fetchFn: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("broken error body"));
            },
          }),
          {
            status: 502,
            headers: { "x-request-id": "req-vydra-broken-body" },
          },
        ),
      maxBytes: 1024 * 1024,
    }).catch((error: unknown) => error);

    expect(result).toMatchObject({
      name: "ProviderHttpError",
      status: 502,
      statusCode: 502,
      requestId: "req-vydra-broken-body",
    });
  });

  it("does not bound a dripping body when only chunk idle timeout is used", async () => {
    // Negative control: chunkTimeoutMs resets on every drip, so idle alone never fires.
    const port = await listenDripServer({
      statusCode: 200,
      contentType: "image/png",
      chunk: Buffer.from([0x00]),
    });
    const response = await fetch(`http://127.0.0.1:${port}/`);
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
