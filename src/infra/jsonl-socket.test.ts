import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { requestJsonlSocket } from "./jsonl-socket.js";

async function listenOnSocket(server: net.Server, socketPath: string): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      return false;
    }
    throw err;
  }
}

function acceptDoneValue(msg: unknown): number | null | undefined {
  const value = msg as { type?: string; value?: number };
  return value.type === "done" ? (value.value ?? null) : undefined;
}

describe.runIf(process.platform !== "win32")("requestJsonlSocket", () => {
  it("ignores malformed and non-accepted lines until one is accepted", async () => {
    await withTempDir({ prefix: "openclaw-jsonl-socket-" }, async (dir) => {
      const socketPath = path.join(dir, "socket.sock");
      const server = net.createServer((socket) => {
        socket.on("data", () => {
          socket.write("{bad json}\n");
          socket.write('{"type":"ignore"}\n');
          socket.write('{"type":"done","value":42}\n');
        });
      });
      const listening = await listenOnSocket(server, socketPath);
      if (!listening) {
        return;
      }

      try {
        await expect(
          requestJsonlSocket({
            socketPath,
            requestLine: '{"hello":"world"}',
            timeoutMs: 500,
            accept: acceptDoneValue,
          }),
        ).resolves.toBe(42);
      } finally {
        server.close();
      }
    });
  });

  it("half-closes the write side after sending the request line", async () => {
    await withTempDir({ prefix: "openclaw-jsonl-socket-" }, async (dir) => {
      const socketPath = path.join(dir, "socket.sock");
      let receivedBuffer: string | null = null;
      const server = net.createServer((socket) => {
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
        });
        socket.on("end", () => {
          receivedBuffer = buffer;
          socket.end('{"type":"done","value":7}\n');
        });
      });
      const listening = await listenOnSocket(server, socketPath);
      if (!listening) {
        return;
      }

      try {
        await expect(
          requestJsonlSocket({
            socketPath,
            requestLine: '{"hello":"world"}',
            timeoutMs: 500,
            accept: acceptDoneValue,
          }),
        ).resolves.toBe(7);
        expect(receivedBuffer).toBe('{"hello":"world"}\n');
      } finally {
        server.close();
      }
    });
  });

  it("returns null on timeout and on socket errors", async () => {
    await withTempDir({ prefix: "openclaw-jsonl-socket-" }, async (dir) => {
      const socketPath = path.join(dir, "socket.sock");
      const server = net.createServer(() => {
        // Intentionally never reply.
      });
      const listening = await listenOnSocket(server, socketPath);
      if (!listening) {
        return;
      }

      try {
        await expect(
          requestJsonlSocket({
            socketPath,
            requestLine: "{}",
            timeoutMs: 50,
            accept: () => undefined,
          }),
        ).resolves.toBeNull();
      } finally {
        server.close();
      }

      await expect(
        requestJsonlSocket({
          socketPath,
          requestLine: "{}",
          timeoutMs: 50,
          accept: () => undefined,
        }),
      ).resolves.toBeNull();
    });
  });
});
