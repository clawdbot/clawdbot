// WhatsApp production-path proof: real saveMediaStream, stalled Baileys iterable.
import fs from "node:fs/promises";
import http, { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { captureEnv } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mockNormalizeMessageContent } from "../../../../test/mocks/baileys.js";

type MockMessageInput = Parameters<typeof mockNormalizeMessageContent>[0];

const { normalizeMessageContent, downloadMediaMessage } = vi.hoisted(() => ({
  normalizeMessageContent: vi.fn((msg: MockMessageInput) => mockNormalizeMessageContent(msg)),
  downloadMediaMessage: vi.fn(),
}));

vi.mock("baileys", async () => {
  return {
    DisconnectReason: { loggedOut: 401 },
    normalizeMessageContent,
    downloadMediaMessage,
  };
});

function getHttpReadable(url: string): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => resolve(res));
    req.on("error", reject);
  });
}

describe("downloadInboundMedia production-path idle proof", () => {
  let downloadInboundMedia: typeof import("./media.js").downloadInboundMedia;
  let saveInboundMediaStreamWithIdleTimeout: typeof import("./media-chunk-idle.js").saveInboundMediaStreamWithIdleTimeout;
  let stateDir = "";
  let envSnapshot: ReturnType<typeof captureEnv>;
  const mockSock = {
    updateMediaMessage: vi.fn(),
    logger: { child: () => ({}) },
  };

  beforeAll(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-idle-proof-"));
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    ({ downloadInboundMedia } = await import("./media.js"));
    ({ saveInboundMediaStreamWithIdleTimeout } = await import("./media-chunk-idle.js"));
  });

  afterEach(async () => {
    normalizeMessageContent.mockClear();
    downloadMediaMessage.mockClear();
  });

  it("times out through production saveMediaStream when Baileys stalls", async () => {
    const neverYielding: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<Buffer>> {
            return new Promise<IteratorResult<Buffer>>(() => {});
          },
        };
      },
    };
    downloadMediaMessage.mockResolvedValueOnce(neverYielding);

    const startedAt = Date.now();
    await expect(
      downloadInboundMedia(
        { message: { imageMessage: { mimetype: "image/jpeg" } } } as never,
        mockSock as never,
        1024 * 1024,
        { chunkTimeoutMs: 50 },
      ),
    ).rejects.toMatchObject({
      name: "WhatsAppInboundMediaTimeoutError",
      chunkTimeoutMs: 50,
    });
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(1_000);
    console.log(
      `[whatsapp media idle production proof] timed_out=true elapsed_ms=${elapsedMs} real_saveMediaStream=true chunkTimeoutMs=50`,
    );
  });

  it("times out a stalled HTTP IncomingMessage and closes the server connection", async () => {
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
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("server failed to bind");
    }
    try {
      const stalled = await getHttpReadable(`http://127.0.0.1:${addr.port}/media`);
      const startedAt = Date.now();
      await expect(
        saveInboundMediaStreamWithIdleTimeout(stalled, "image/jpeg", 1024, undefined, 80),
      ).rejects.toMatchObject({
        name: "WhatsAppInboundMediaTimeoutError",
        chunkTimeoutMs: 80,
      });
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeLessThan(3_000);
      expect(stalled.destroyed).toBe(true);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(serverSawClose).toBe(true);
      console.log(
        `[whatsapp media idle production proof] boundary=http-IncomingMessage timed_out=true elapsed_ms=${elapsedMs} destroyed=true server_close=true`,
      );
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  afterAll(() => {
    envSnapshot.restore();
    return fs.rm(stateDir, { recursive: true, force: true });
  });
});
