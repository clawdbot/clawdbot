import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { attachChildProcessBridge } from "./child-process-bridge.js";

function waitForLine(stream: NodeJS.ReadableStream, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timeout waiting for line"));
    }, timeoutMs);

    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      const idx = buffer.indexOf("\n");
      if (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        cleanup();
        resolve(line);
      }
    };

    const onError = (err: unknown): void => {
      cleanup();
      reject(err);
    };

    const cleanup = (): void => {
      clearTimeout(timeout);
      stream.off("data", onData);
      stream.off("error", onError);
    };

    stream.on("data", onData);
    stream.on("error", onError);
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

describe("attachChildProcessBridge", () => {
  const children: Array<{ kill: (signal?: NodeJS.Signals) => boolean }> = [];
  const detachments: Array<() => void> = [];

  afterEach(() => {
    for (const detach of detachments) {
      try {
        detach();
      } catch {
        // ignore
      }
    }
    detachments.length = 0;
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    children.length = 0;
  });

  it("forwards SIGTERM to the wrapped child", async () => {
    const childPath = path.resolve(process.cwd(), "test/fixtures/child-process-bridge/child.js");

    const beforeSigterm = new Set(process.listeners("SIGTERM"));
    const child = spawn(process.execPath, [childPath], {
      stdio: ["ignore", "pipe", "inherit"],
      env: process.env,
    });
    const { detach } = attachChildProcessBridge(child);
    detachments.push(detach);
    children.push(child);
    const afterSigterm = process.listeners("SIGTERM");
    const addedSigterm = afterSigterm.find((listener) => !beforeSigterm.has(listener));

    if (!child.stdout) throw new Error("expected stdout");
    const portLine = await waitForLine(child.stdout);
    const port = Number(portLine);
    expect(Number.isFinite(port)).toBe(true);

    expect(await canConnect(port)).toBe(true);

    // Simulate systemd sending SIGTERM to the parent process.
    if (!addedSigterm) throw new Error("expected SIGTERM listener");
    addedSigterm();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout waiting for child exit")), 10_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    await new Promise((r) => setTimeout(r, 250));
    expect(await canConnect(port)).toBe(false);
  }, 20_000);
});
