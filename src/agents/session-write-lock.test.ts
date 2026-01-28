import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { __testing, acquireSessionWriteLock } from "./session-write-lock.js";

describe("acquireSessionWriteLock", () => {
  it("reuses locks across symlinked session paths", async () => {
    if (process.platform === "win32") {
      expect(true).toBe(true);
      return;
    }

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-lock-"));
    try {
      const realDir = path.join(root, "real");
      const linkDir = path.join(root, "link");
      await fs.mkdir(realDir, { recursive: true });
      await fs.symlink(realDir, linkDir);

      const sessionReal = path.join(realDir, "sessions.json");
      const sessionLink = path.join(linkDir, "sessions.json");

      const lockA = await acquireSessionWriteLock({ sessionFile: sessionReal, timeoutMs: 500 });
      const lockB = await acquireSessionWriteLock({ sessionFile: sessionLink, timeoutMs: 500 });

      await lockB.release();
      await lockA.release();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the lock file until the last release", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-lock-"));
    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;

      const lockA = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
      const lockB = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });

      await expect(fs.access(lockPath)).resolves.toBeUndefined();
      await lockA.release();
      await expect(fs.access(lockPath)).resolves.toBeUndefined();
      await lockB.release();
      await expect(fs.access(lockPath)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reclaims stale lock files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-lock-"));
    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;
      await fs.writeFile(
        lockPath,
        JSON.stringify({ pid: 123456, createdAt: new Date(Date.now() - 60_000).toISOString() }),
        "utf8",
      );

      const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500, staleMs: 10 });
      const raw = await fs.readFile(lockPath, "utf8");
      const payload = JSON.parse(raw) as { pid: number };

      expect(payload.pid).toBe(process.pid);
      await lock.release();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes held locks on termination signals", async () => {
    const signals = ["SIGINT", "SIGTERM", "SIGQUIT", "SIGABRT"] as const;
    for (const signal of signals) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-lock-cleanup-"));
      try {
        const sessionFile = path.join(root, "sessions.json");
        const lockPath = `${sessionFile}.lock`;
        await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
        const keepAlive = () => {};
        if (signal === "SIGINT") {
          process.on(signal, keepAlive);
        }

        __testing.handleTerminationSignal(signal);

        await expect(fs.stat(lockPath)).rejects.toThrow();
        if (signal === "SIGINT") {
          process.off(signal, keepAlive);
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

  it("registers cleanup for SIGQUIT and SIGABRT", () => {
    expect(__testing.cleanupSignals).toContain("SIGQUIT");
    expect(__testing.cleanupSignals).toContain("SIGABRT");
  });
  it("cleans up locks on SIGINT without removing other handlers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-lock-"));
    const originalKill = process.kill.bind(process) as typeof process.kill;
    const killCalls: Array<NodeJS.Signals | undefined> = [];
    let otherHandlerCalled = false;

    process.kill = ((pid: number, signal?: NodeJS.Signals) => {
      killCalls.push(signal);
      return true;
    }) as typeof process.kill;

    const otherHandler = () => {
      otherHandlerCalled = true;
    };

    process.on("SIGINT", otherHandler);

    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;
      await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });

      process.emit("SIGINT");

      await expect(fs.access(lockPath)).rejects.toThrow();
      expect(otherHandlerCalled).toBe(true);
      expect(killCalls).toEqual([]);
    } finally {
      process.off("SIGINT", otherHandler);
      process.kill = originalKill;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("cleans up locks on exit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-lock-"));
    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;
      await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });

      process.emit("exit", 0);

      await expect(fs.access(lockPath)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("keeps other signal listeners registered", () => {
    const keepAlive = () => {};
    process.on("SIGINT", keepAlive);

    __testing.handleTerminationSignal("SIGINT");

    expect(process.listeners("SIGINT")).toContain(keepAlive);
    process.off("SIGINT", keepAlive);
  });
});
