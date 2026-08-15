import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinuxCanvasIpcClient } from "./ipc-client.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Linux Canvas IPC client", () => {
  it("keeps the outer timeout above the app's complete A2UI phase budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-linux-canvas-timeout-"));
    tempDirs.push(dir);
    const socketPath = path.join(dir, "canvas.sock");
    let resolveRequest: (() => void) | undefined;
    const requestReceived = new Promise<void>((resolve) => {
      resolveRequest = resolve;
    });
    const server = net.createServer((socket) => {
      socket.once("data", () => {
        resolveRequest?.();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    const client = new LinuxCanvasIpcClient(socketPath);
    try {
      const request = client.request("canvas.present", "{}");
      const settled = vi.fn();
      void request.then(settled, settled);
      await requestReceived;

      await vi.advanceTimersByTimeAsync(8_000 + 6_000 + 8_000);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(request).rejects.toThrow("desktop app timed out handling canvas.present");
    } finally {
      client.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("maps requests to responses without corrupting split UTF-8 frames", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-linux-canvas-"));
    tempDirs.push(dir);
    const socketPath = path.join(dir, "canvas.sock");
    let resolveRequest:
      | ((value: { frame: Record<string, unknown>; socket: net.Socket }) => void)
      | undefined;
    const requestReceived = new Promise<{ frame: Record<string, unknown>; socket: net.Socket }>(
      (resolve) => {
        resolveRequest = resolve;
      },
    );
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          return;
        }
        resolveRequest?.({
          frame: JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>,
          socket,
        });
        resolveRequest = undefined;
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    const client = new LinuxCanvasIpcClient(socketPath, 1_000);
    try {
      const resultPromise = client.request("canvas.eval", '{"javaScript":"document.title"}');
      const { frame, socket } = await requestReceived;
      expect(frame).toMatchObject({
        command: "canvas.eval",
        paramsJSON: '{"javaScript":"document.title"}',
      });

      const payloadJSON = JSON.stringify({ result: "paw 🐾" });
      const response = Buffer.from(
        `${JSON.stringify({ id: frame.id, ok: true, payloadJSON })}\n`,
        "utf8",
      );
      const emojiOffset = response.indexOf(Buffer.from("🐾", "utf8"));
      expect(emojiOffset).toBeGreaterThan(0);
      socket.write(response.subarray(0, emojiOffset + 1));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      socket.write(response.subarray(emojiOffset + 1));

      await expect(resultPromise).resolves.toBe(payloadJSON);
    } finally {
      client.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("rejects success frames without valid payload JSON", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-linux-canvas-invalid-"));
    tempDirs.push(dir);
    const socketPath = path.join(dir, "canvas.sock");
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          return;
        }
        const request = JSON.parse(buffer.slice(0, newline)) as { id: string };
        socket.write(`${JSON.stringify({ id: request.id, ok: true, payloadJSON: "{" })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    const client = new LinuxCanvasIpcClient(socketPath, 1_000);
    try {
      await expect(client.request("canvas.hide", "{}")).rejects.toThrow("invalid payload JSON");
    } finally {
      client.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("does not dispatch a queued request before the prior response", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-linux-canvas-queue-"));
    tempDirs.push(dir);
    const socketPath = path.join(dir, "canvas.sock");
    const requests: Array<{ id: string; command: string }> = [];
    let notifyRequest: (() => void) | undefined;
    let peer: net.Socket | undefined;
    const server = net.createServer((socket) => {
      peer = socket;
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          requests.push(JSON.parse(buffer.slice(0, newline)) as { id: string; command: string });
          buffer = buffer.slice(newline + 1);
          notifyRequest?.();
          notifyRequest = undefined;
          newline = buffer.indexOf("\n");
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const waitForRequest = async (count: number) => {
      while (requests.length < count) {
        await new Promise<void>((resolve) => {
          notifyRequest = resolve;
        });
      }
    };

    const client = new LinuxCanvasIpcClient(socketPath, 1_000);
    const dispatched: string[] = [];
    try {
      const first = client.request("canvas.navigate", '{"url":"https://one.example"}', {
        onDispatch: () => dispatched.push("first"),
      });
      const second = client.request("canvas.navigate", '{"url":"https://two.example"}', {
        onDispatch: () => dispatched.push("second"),
      });
      await waitForRequest(1);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(requests.map((request) => request.command)).toEqual(["canvas.navigate"]);
      expect(dispatched).toEqual(["first"]);

      if (!peer) {
        throw new Error("test server did not accept the Canvas connection");
      }
      peer.write(
        `${JSON.stringify({ id: requests[0]?.id, ok: true, payloadJSON: '{"ok":true}' })}\n`,
      );
      await expect(first).resolves.toBe('{"ok":true}');
      await waitForRequest(2);
      expect(dispatched).toEqual(["first", "second"]);
      peer.write(
        `${JSON.stringify({ id: requests[1]?.id, ok: true, payloadJSON: '{"ok":true}' })}\n`,
      );
      await expect(second).resolves.toBe('{"ok":true}');
    } finally {
      client.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("rejects queued work without reconnecting after close", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-linux-canvas-close-"));
    tempDirs.push(dir);
    const socketPath = path.join(dir, "canvas.sock");
    let connections = 0;
    let requests = 0;
    let resolveRequest: (() => void) | undefined;
    const requestReceived = new Promise<void>((resolve) => {
      resolveRequest = resolve;
    });
    const server = net.createServer((socket) => {
      connections += 1;
      socket.once("data", () => {
        requests += 1;
        resolveRequest?.();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    const client = new LinuxCanvasIpcClient(socketPath, 1_000);
    const first = client.request("canvas.navigate", '{"url":"https://one.example"}');
    const second = client.request("canvas.navigate", '{"url":"https://two.example"}');
    await requestReceived;
    client.close();

    await expect(first).rejects.toThrow("shutting down");
    await expect(second).rejects.toThrow("shutting down");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(connections).toBe(1);
    expect(requests).toBe(1);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
});
