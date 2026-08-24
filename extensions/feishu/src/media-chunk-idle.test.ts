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
    let serverSawClose = false;
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": "1048576" });
      res.flushHeaders();
      const markClose = () => {
        serverSawClose = true;
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
      const stalled = await getHttpReadable(`http://127.0.0.1:${address.port}/media`);
      await expect(
        saveMediaStreamWithIdleTimeout(stalled, "image/jpeg", 1024, undefined, 50),
      ).rejects.toMatchObject({
        name: "FeishuInboundMediaTimeoutError",
        chunkTimeoutMs: 50,
      });
      expect(stalled.destroyed).toBe(true);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(serverSawClose).toBe(true);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
