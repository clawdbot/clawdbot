import fs from "node:fs/promises";
import http, { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { captureEnv } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveMediaStreamWithIdleTimeout } from "./media-chunk-idle.js";

function getHttpReadable(url: string): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, resolve);
    req.on("error", reject);
  });
}

async function withStalledHttpServer(
  run: (ctx: {
    mediaUrl: string;
    closed: Promise<void>;
    serverSawClose: () => boolean;
  }) => Promise<void>,
): Promise<void> {
  let sawClose = false;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "image/jpeg", "content-length": "1048576" });
    res.flushHeaders();
    const markClose = () => {
      sawClose = true;
      resolveClosed();
    };
    req.on("close", markClose);
    res.on("close", markClose);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server failed to bind");
  }

  try {
    await run({
      mediaUrl: `http://127.0.0.1:${address.port}/media`,
      closed,
      serverSawClose: () => sawClose,
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("saveMediaStreamWithIdleTimeout", () => {
  let stateDir = "";
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeAll(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-idle-"));
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterAll(async () => {
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("keeps the timeout authoritative when teardown synchronously ends iteration", async () => {
    let resolveNext: ((result: IteratorResult<Buffer>) => void) | undefined;
    const stalled = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<Buffer>>((resolve) => {
              resolveNext = resolve;
            }),
        };
      },
      destroy() {
        resolveNext?.({ done: true, value: undefined });
      },
    };

    await expect(
      saveMediaStreamWithIdleTimeout(stalled, "image/jpeg", 1024, undefined, 10),
    ).rejects.toMatchObject({
      name: "FeishuInboundMediaTimeoutError",
      chunkTimeoutMs: 10,
    });
  });

  it("times out a stalled SDK-style HTTP stream and closes its connection", async () => {
    await withStalledHttpServer(async ({ mediaUrl, closed, serverSawClose }) => {
      const stalled = await getHttpReadable(mediaUrl);
      await expect(
        saveMediaStreamWithIdleTimeout(stalled, "image/jpeg", 1024, undefined, 50),
      ).rejects.toMatchObject({
        name: "FeishuInboundMediaTimeoutError",
        chunkTimeoutMs: 50,
      });
      expect(stalled.destroyed).toBe(true);
      await closed;
      expect(serverSawClose()).toBe(true);
    });
  });

  it("observes the connection close even when teardown lands past the old 20ms window", async () => {
    await withStalledHttpServer(async ({ mediaUrl, closed, serverSawClose }) => {
      const stalled = await getHttpReadable(mediaUrl);
      const realDestroy = stalled.destroy.bind(stalled);
      stalled.destroy = ((error?: Error) => {
        setTimeout(() => realDestroy(error), 60);
        return stalled;
      }) as typeof stalled.destroy;
      await expect(
        saveMediaStreamWithIdleTimeout(stalled, "image/jpeg", 1024, undefined, 50),
      ).rejects.toMatchObject({
        name: "FeishuInboundMediaTimeoutError",
        chunkTimeoutMs: 50,
      });
      await closed;
      expect(stalled.destroyed).toBe(true);
      expect(serverSawClose()).toBe(true);
    });
  });
});
