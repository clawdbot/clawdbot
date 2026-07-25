// Media store remote download timeout coverage for hung/stalled HTTP sources.
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinnedLookup } from "../infra/net/ssrf.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { setMediaStoreDownloadDepsForTest } from "./store.download.js";
import { saveMediaSource } from "./store.js";

const HEADER_TIMEOUT_MS = 40;
const IDLE_TIMEOUT_MS = 40;

function waitForSocketClose(req: http.IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    if (req.socket.destroyed) {
      resolve();
      return;
    }
    req.socket.once("close", resolve);
  });
}

async function expectSocketClosed(closed: Promise<void> | undefined): Promise<void> {
  if (!closed) {
    throw new Error("server request was not observed");
  }
  await Promise.race([
    closed,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("server socket remained open")), 1_000).unref();
    }),
  ]);
}

async function listMediaFiles(root: string): Promise<string[]> {
  const entries: string[] = [];
  async function walk(dir: string) {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      const stat = await fs.lstat(full);
      if (stat.isDirectory()) {
        await walk(full);
      } else {
        entries.push(full);
      }
    }
  }
  await walk(root);
  return entries;
}

function createInjectedRequest(onEnd: (response: PassThrough) => void): {
  requestImpl: typeof http.request;
  requestEnded: Promise<void>;
} {
  const response = Object.assign(new PassThrough(), {
    statusCode: 200,
    headers: { "content-type": "text/plain" },
  });
  let markRequestEnded!: () => void;
  const requestEnded = new Promise<void>((resolve) => {
    markRequestEnded = resolve;
  });
  const request = Object.assign(new EventEmitter(), {
    end: () => {
      onEnd(response);
      markRequestEnded();
    },
    destroy: (err?: Error) => {
      if (err) {
        request.emit("error", err);
      }
      response.destroy();
    },
  }) as unknown as ReturnType<typeof http.request>;
  const requestImpl = ((_url: URL, _options: unknown, onResponse: (res: unknown) => void) => {
    onResponse(response);
    return request;
  }) as unknown as typeof http.request;
  return { requestImpl, requestEnded };
}

function useInjectedRequest(
  requestImpl: typeof http.request,
  timeouts: { responseHeaderTimeoutMs: number; readIdleTimeoutMs: number },
): void {
  setMediaStoreDownloadDepsForTest({
    httpRequest: requestImpl,
    resolvePinnedHostname: async (hostname) => ({
      hostname,
      addresses: ["127.0.0.1"],
      lookup: createPinnedLookup({ hostname, addresses: ["127.0.0.1"] }),
    }),
    ...timeouts,
  });
}

// Tight budgets go only on the phase a test asserts times out. Phases expected
// to make progress keep production-default budgets: a 40ms real-timer watchdog
// on a progressing phase fires spuriously under CI worker contention.
function usePinnedResolver(timeouts?: {
  responseHeaderTimeoutMs?: number;
  readIdleTimeoutMs?: number;
}): void {
  setMediaStoreDownloadDepsForTest({
    resolvePinnedHostname: async (hostname) => ({
      hostname,
      addresses: ["127.0.0.1"],
      lookup: createPinnedLookup({ hostname, addresses: ["127.0.0.1"] }),
    }),
    ...timeouts,
  });
}

describe("media store download timeouts", () => {
  let testState: OpenClawTestState;
  let mediaRoot: string;
  let server: http.Server;
  let baseUrl: string;
  let mode: "hang-headers" | "stall-body" | "stall-error" | "stall-redirect" | "ok" = "ok";
  let openSockets: Set<import("node:net").Socket>;
  let stalledSocketClosed: Promise<void> | undefined;

  beforeAll(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-media-store-download-timeout-",
    });
    mediaRoot = path.join(testState.stateDir, "media");
    openSockets = new Set();
    server = http.createServer((req, res) => {
      if (mode === "hang-headers") {
        stalledSocketClosed = waitForSocketClose(req);
        // Accept the request but never write status/headers/body.
        req.resume();
        return;
      }
      if (mode === "stall-body") {
        stalledSocketClosed = waitForSocketClose(req);
        res.writeHead(200, {
          "content-type": "text/plain",
          "content-length": "20",
        });
        res.write("partial");
        // Leave the response open without finishing.
        return;
      }
      if (mode === "stall-error") {
        stalledSocketClosed = waitForSocketClose(req);
        res.writeHead(500, { "content-type": "text/plain", "content-length": "20" });
        res.write("partial error");
        return;
      }
      if (mode === "stall-redirect" && req.url !== "/redirect-target") {
        stalledSocketClosed = waitForSocketClose(req);
        res.writeHead(302, { location: "/redirect-target", "content-length": "20" });
        res.write("partial redirect");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    server.on("connection", (socket) => {
      openSockets.add(socket);
      socket.on("close", () => {
        openSockets.delete(socket);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/media.bin`;
  });

  beforeEach(() => {
    mode = "ok";
    stalledSocketClosed = undefined;
    usePinnedResolver();
  });

  afterEach(async () => {
    for (const socket of Array.from(openSockets)) {
      socket.destroy();
    }
    setMediaStoreDownloadDepsForTest();
    await fs.rm(mediaRoot, { recursive: true, force: true }).catch(() => {});
  });

  afterAll(async () => {
    for (const socket of Array.from(openSockets)) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await testState.cleanup();
    setMediaStoreDownloadDepsForTest();
  });

  it("times out when the server accepts a connection but never sends headers", async () => {
    mode = "hang-headers";
    usePinnedResolver({ responseHeaderTimeoutMs: HEADER_TIMEOUT_MS });
    await expect(saveMediaSource(baseUrl)).rejects.toThrow(
      /timed out waiting for response headers after 40ms/i,
    );
    await expectSocketClosed(stalledSocketClosed);
    expect(await listMediaFiles(mediaRoot)).toEqual([]);
  });

  it("times out when hostname resolution never settles", async () => {
    let requestStarted = false;
    setMediaStoreDownloadDepsForTest({
      httpRequest: (() => {
        requestStarted = true;
        throw new Error("request must not start after DNS timeout");
      }) as unknown as typeof http.request,
      resolvePinnedHostname: async () => await new Promise<never>(() => {}),
      responseHeaderTimeoutMs: HEADER_TIMEOUT_MS,
    });

    await expect(saveMediaSource(baseUrl)).rejects.toThrow(
      /timed out waiting for response headers after 40ms/i,
    );
    expect(requestStarted).toBe(false);
    expect(await listMediaFiles(mediaRoot)).toEqual([]);
  });

  it("times out when the response body stalls after partial data", async () => {
    mode = "stall-body";
    usePinnedResolver({ readIdleTimeoutMs: IDLE_TIMEOUT_MS });
    await expect(saveMediaSource(baseUrl)).rejects.toThrow(/stalled: no data received for 40ms/i);
    await expectSocketClosed(stalledSocketClosed);
    expect(await listMediaFiles(mediaRoot)).toEqual([]);
  });

  it("closes an error response whose body never finishes", async () => {
    mode = "stall-error";
    await expect(saveMediaSource(baseUrl)).rejects.toThrow(/HTTP 500 downloading media/i);
    await expectSocketClosed(stalledSocketClosed);
    expect(await listMediaFiles(mediaRoot)).toEqual([]);
  });

  it("closes a stalled redirect body before following the next hop", async () => {
    mode = "stall-redirect";
    const saved = await saveMediaSource(baseUrl);
    await expectSocketClosed(stalledSocketClosed);
    expect(await fs.readFile(saved.path, "utf8")).toBe("ok");
  });

  it("keeps a slow response alive while each body chunk makes progress", async () => {
    vi.useFakeTimers();
    try {
      const { requestImpl, requestEnded } = createInjectedRequest((response) => {
        response.write("a");
        let chunksRemaining = 5;
        const interval = setInterval(() => {
          chunksRemaining -= 1;
          if (chunksRemaining === 0) {
            clearInterval(interval);
            response.end("e");
            return;
          }
          response.write("a");
        }, 50);
        response.once("close", () => clearInterval(interval));
      });
      useInjectedRequest(requestImpl, {
        responseHeaderTimeoutMs: 500,
        readIdleTimeoutMs: 200,
      });

      const result = saveMediaSource(baseUrl);
      await requestEnded;
      await vi.advanceTimersByTimeAsync(250);

      const saved = await result;
      expect(await fs.readFile(saved.path, "utf8")).toBe("aaaaae");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the header deadline when an injected request responds synchronously", async () => {
    vi.useFakeTimers();
    try {
      const { requestImpl, requestEnded } = createInjectedRequest((response) => {
        setTimeout(() => response.end("sync response"), 80);
      });
      useInjectedRequest(requestImpl, {
        responseHeaderTimeoutMs: 30,
        readIdleTimeoutMs: 200,
      });

      const result = saveMediaSource(baseUrl);
      await requestEnded;
      await vi.advanceTimersByTimeAsync(80);

      const saved = await result;
      expect(await fs.readFile(saved.path, "utf8")).toBe("sync response");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still saves when the remote body completes before idle timeout", async () => {
    mode = "ok";
    const saved = await saveMediaSource(baseUrl);
    expect(await fs.readFile(saved.path, "utf8")).toBe("ok");
    expect(saved.contentType).toBe("text/plain");
  });
});
