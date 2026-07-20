import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  resolveBrowserControlAuth: vi.fn(() => ({})),
  getBridgeAuthForPort: vi.fn(() => undefined),
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return { ...actual, getRuntimeConfig: authMocks.loadConfig, loadConfig: authMocks.loadConfig };
});
vi.mock("./control-auth.js", () => ({
  resolveBrowserControlAuth: authMocks.resolveBrowserControlAuth,
}));
vi.mock("./bridge-auth-registry.js", () => ({
  getBridgeAuthForPort: authMocks.getBridgeAuthForPort,
}));

const { fetchBrowserJson } = await import("./client-fetch.js");

const STREAM_CHUNK = Buffer.alloc(4 * 1024, "x");
const STREAM_BODY_BYTES = 1024 * 1024;
const SUCCESS_STREAM_CHUNK = Buffer.alloc(64 * 1024, "x");
const SUCCESS_STREAM_BODY_BYTES = 33 * 1024 * 1024;
const BROWSER_SUCCESS_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

function scheduleStreamChunk(writeNext: () => void): void {
  // Separate event-loop turns preserve streaming and backpressure without a wall-clock sleep.
  setImmediate(writeNext);
}

describe("fetchHttpJson error body boundary", () => {
  let server: http.Server;
  let baseUrl: string;
  let streamClosed: Promise<void>;
  let resolveStreamClosed: () => void;
  let smallConnectionClosed: Promise<void>;
  let resolveSmallConnectionClosed: () => void;
  let successStreamClosed: Promise<void>;
  let resolveSuccessStreamClosed: () => void;
  let malformedSuccessConnectionClosed: Promise<void>;
  let resolveMalformedSuccessConnectionClosed: () => void;
  let malformedErrorConnectionClosed: Promise<void>;
  let resolveMalformedErrorConnectionClosed: () => void;
  let streamCompleted: boolean;
  let successStreamCompleted: boolean;

  beforeEach(async () => {
    for (const key of [
      "ALL_PROXY",
      "all_proxy",
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
    ]) {
      vi.stubEnv(key, "");
    }

    streamClosed = new Promise<void>((resolve) => {
      resolveStreamClosed = resolve;
    });
    smallConnectionClosed = new Promise<void>((resolve) => {
      resolveSmallConnectionClosed = resolve;
    });
    successStreamClosed = new Promise<void>((resolve) => {
      resolveSuccessStreamClosed = resolve;
    });
    malformedSuccessConnectionClosed = new Promise<void>((resolve) => {
      resolveMalformedSuccessConnectionClosed = resolve;
    });
    malformedErrorConnectionClosed = new Promise<void>((resolve) => {
      resolveMalformedErrorConnectionClosed = resolve;
    });
    streamCompleted = false;
    successStreamCompleted = false;
    server = http.createServer((req, res) => {
      if (req.url === "/success-small") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"payload":"control"}');
        return;
      }
      if (req.url === "/success-malformed-utf8") {
        req.socket.once("close", () => resolveMalformedSuccessConnectionClosed());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          Buffer.concat([Buffer.from('{"payload":"'), Buffer.from([0xff]), Buffer.from('"}')]),
        );
        return;
      }
      if (req.url === "/error-malformed-utf8") {
        req.socket.once("close", () => resolveMalformedErrorConnectionClosed());
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          Buffer.concat([
            Buffer.from('{"error":"control '),
            Buffer.from([0xff]),
            Buffer.from('"}'),
          ]),
        );
        return;
      }
      if (req.url === "/success-large") {
        let written = 0;
        let closed = false;
        res.once("close", () => {
          closed = true;
          resolveSuccessStreamClosed();
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"payload":"');
        const writeNext = () => {
          if (closed) {
            return;
          }
          if (written >= SUCCESS_STREAM_BODY_BYTES) {
            successStreamCompleted = true;
            res.end('"}');
            return;
          }
          const remaining = SUCCESS_STREAM_BODY_BYTES - written;
          const chunk =
            remaining >= SUCCESS_STREAM_CHUNK.byteLength
              ? SUCCESS_STREAM_CHUNK
              : SUCCESS_STREAM_CHUNK.subarray(0, remaining);
          written += chunk.byteLength;
          if (res.write(chunk)) {
            scheduleStreamChunk(writeNext);
          } else {
            res.once("drain", () => scheduleStreamChunk(writeNext));
          }
        };
        writeNext();
        return;
      }

      if (req.url === "/small") {
        req.socket.once("close", () => resolveSmallConnectionClosed());
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("session expired");
        return;
      }

      if (req.url === "/structured") {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "display required",
            reason: "no_display_for_headed_profile",
            details: {
              profile: "openclaw",
              requestedHeadless: false,
              headlessSource: "config",
              displayPresent: false,
            },
          }),
        );
        return;
      }

      res.writeHead(500, { "Content-Type": "text/plain" });
      let written = 0;
      let closed = false;
      res.once("close", () => {
        closed = true;
        resolveStreamClosed();
      });
      const writeNext = () => {
        if (closed) {
          return;
        }
        if (written >= STREAM_BODY_BYTES) {
          streamCompleted = true;
          res.end();
          return;
        }
        written += STREAM_CHUNK.byteLength;
        if (res.write(STREAM_CHUNK)) {
          scheduleStreamChunk(writeNext);
        } else {
          res.once("drain", () => scheduleStreamChunk(writeNext));
        }
      };
      writeNext();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("cancels an overflowing stream and releases the guarded fetch", async () => {
    const error = await fetchBrowserJson(`${baseUrl}/large`).catch((err: unknown) => err);

    expect(error).toMatchObject({ name: "BrowserServiceError", message: "HTTP 500" });
    await expect(streamClosed).resolves.toBeUndefined();
    expect(streamCompleted).toBe(false);
  });

  it("cancels an overflowing successful JSON response", async () => {
    const error = await fetchBrowserJson(`${baseUrl}/success-large`).catch((err: unknown) => err);

    expect(error).toMatchObject({
      name: "BrowserServiceError",
      message: `Browser control response exceeded ${BROWSER_SUCCESS_BODY_LIMIT_BYTES} bytes`,
    });
    await expect(successStreamClosed).resolves.toBeUndefined();
    expect(successStreamCompleted).toBe(false);
  });

  it("preserves a normal successful JSON response", async () => {
    await expect(fetchBrowserJson(`${baseUrl}/success-small`)).resolves.toEqual({
      payload: "control",
    });
  });

  it("rejects malformed UTF-8 JSON and releases the guarded fetch", async () => {
    const error = await fetchBrowserJson(`${baseUrl}/success-malformed-utf8`).catch(
      (err: unknown) => err,
    );

    expect(error).toMatchObject({
      name: "BrowserServiceError",
      message: "Browser control response was not valid UTF-8 (HTTP 200)",
      status: 200,
    });
    await expect(malformedSuccessConnectionClosed).resolves.toBeUndefined();
  });

  it("rejects malformed UTF-8 error JSON and releases the guarded fetch", async () => {
    const error = await fetchBrowserJson(`${baseUrl}/error-malformed-utf8`).catch(
      (err: unknown) => err,
    );

    expect(error).toMatchObject({
      name: "BrowserServiceError",
      message: "Browser control response was not valid UTF-8 (HTTP 500)",
      status: 500,
    });
    await expect(malformedErrorConnectionClosed).resolves.toBeUndefined();
  });

  it("preserves a complete diagnostic body within the limit", async () => {
    const error = await fetchBrowserJson(`${baseUrl}/small`).catch((err: unknown) => err);

    expect(error).toMatchObject({
      name: "BrowserServiceError",
      message: "session expired",
    });
    await expect(smallConnectionClosed).resolves.toBeUndefined();
  });

  it("preserves validated structured errors over HTTP", async () => {
    const error = await fetchBrowserJson(`${baseUrl}/structured`).catch((err: unknown) => err);

    expect(error).toMatchObject({
      name: "BrowserServiceError",
      message: "display required",
      reason: "no_display_for_headed_profile",
      details: {
        profile: "openclaw",
        requestedHeadless: false,
        headlessSource: "config",
        displayPresent: false,
      },
    });
  });
});
