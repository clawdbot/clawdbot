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
const MALFORMED_UTF8_STATUSES = [200, 401, 408, 500, 504] as const;

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
  let malformedConnectionClosed: Map<number, Promise<void>>;
  let resolveMalformedConnectionClosed: Map<number, () => void>;
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
    malformedConnectionClosed = new Map();
    resolveMalformedConnectionClosed = new Map();
    for (const status of MALFORMED_UTF8_STATUSES) {
      malformedConnectionClosed.set(
        status,
        new Promise<void>((resolve) => {
          resolveMalformedConnectionClosed.set(status, resolve);
        }),
      );
    }
    streamCompleted = false;
    successStreamCompleted = false;
    server = http.createServer((req, res) => {
      if (req.url === "/success-small") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"payload":"control 🦞"}');
        return;
      }
      const malformedStatus = Number(req.url?.match(/^\/malformed-utf8\/(\d+)$/)?.[1]);
      if (MALFORMED_UTF8_STATUSES.some((status) => status === malformedStatus)) {
        req.socket.once("close", () => resolveMalformedConnectionClosed.get(malformedStatus)?.());
        res.writeHead(malformedStatus, { "Content-Type": "application/json" });
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

      if (req.url === "/evaluate-disabled") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "evaluation disabled", code: "ACT_EVALUATE_DISABLED" }));
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
      payload: "control 🦞",
    });
  });

  it("rejects malformed UTF-8 responses, preserves retry policy, and releases each fetch", async () => {
    for (const status of MALFORMED_UTF8_STATUSES) {
      const error = await fetchBrowserJson(`${baseUrl}/malformed-utf8/${status}`).catch(
        (err: unknown) => err,
      );

      expect(error).toMatchObject({
        name: "BrowserServiceError",
        status,
      });
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain(`Browser control response was not valid UTF-8 (HTTP ${status})`);
      if (status === 401) {
        expect(message).toContain("Do NOT retry the browser tool");
      } else if (status === 408 || status === 504) {
        expect(message).toContain("Retry the browser tool once");
      } else {
        expect(message).not.toContain("Retry the browser tool");
      }
      const connectionClosed = malformedConnectionClosed.get(status);
      expect(connectionClosed).toBeDefined();
      await expect(connectionClosed).resolves.toBeUndefined();
    }
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

  it("preserves validated browser action error codes over HTTP", async () => {
    const error = await fetchBrowserJson(`${baseUrl}/evaluate-disabled`).catch(
      (err: unknown) => err,
    );

    expect(error).toMatchObject({
      name: "BrowserServiceError",
      message: "evaluation disabled",
      code: "ACT_EVALUATE_DISABLED",
      status: 403,
    });
  });
});
