import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionWriteLockStaleError,
  SessionWriteLockTimeoutError,
} from "../agents/session-write-lock-error.js";
import { drainSessionWriteLockStateForTest } from "../agents/session-write-lock.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  acquireSessionWriteLock,
  drainSessionFileWriteLockStateForTest,
} from "./session-write-lock-runtime.js";

describe("Plugin SDK session write-lock adapter", () => {
  let root = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sdk-session-lock-"));
  });

  afterEach(async () => {
    await drainSessionFileWriteLockStateForTest();
    await drainSessionWriteLockStateForTest();
    closeOpenClawAgentDatabasesForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("retains the shipped default file-artifact contract", async () => {
    const sessionFile = path.join(root, "nested", "session.jsonl");
    const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
    const payload = JSON.parse(await fs.readFile(`${sessionFile}.lock`, "utf8")) as {
      pid: number;
    };
    expect(payload.pid).toBe(process.pid);

    await lock.release();
    await expect(fs.access(`${sessionFile}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("synchronously releases file sidecars on termination signals", async () => {
    const sessionFile = path.join(root, "session.jsonl");
    await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
    const keepAlive = () => {};
    process.on("SIGTERM", keepAlive);
    try {
      process.emit("SIGTERM");
      await expect(fs.access(`${sessionFile}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.off("SIGTERM", keepAlive);
    }
  });

  it("reference-counts an explicit reentrant owner", async () => {
    const sessionFile = path.join(root, "session.jsonl");
    const first = await acquireSessionWriteLock({
      sessionFile,
      timeoutMs: 500,
      reentrantOwner: "plugin-run",
    });
    const second = await acquireSessionWriteLock({
      sessionFile,
      timeoutMs: 500,
      reentrantOwner: "plugin-run",
    });

    await first.release();
    await expect(fs.access(`${sessionFile}.lock`)).resolves.toBeUndefined();
    await second.release();
    await expect(fs.access(`${sessionFile}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")("canonicalizes symlink aliases", async () => {
    const real = path.join(root, "real");
    const alias = path.join(root, "alias");
    await fs.mkdir(real);
    await fs.symlink(real, alias);
    const owner = "plugin-alias";
    const first = await acquireSessionWriteLock({
      sessionFile: path.join(real, "session.jsonl"),
      timeoutMs: 500,
      reentrantOwner: owner,
    });
    const second = await acquireSessionWriteLock({
      sessionFile: path.join(alias, "session.jsonl"),
      timeoutMs: 500,
      reentrantOwner: owner,
    });
    await Promise.all([first.release(), second.release()]);
  });

  it("reports contention through the stable timeout error", async () => {
    const sessionFile = path.join(root, "session.jsonl");
    const held = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
    const pending = acquireSessionWriteLock({ sessionFile, timeoutMs: 5 });

    await expect(pending).rejects.toMatchObject({
      name: "SessionWriteLockTimeoutError",
      code: "OPENCLAW_SESSION_WRITE_LOCK_TIMEOUT",
      timeoutMs: 5,
      lockPath: path.join(await fs.realpath(root), "session.jsonl.lock"),
    } satisfies Partial<SessionWriteLockTimeoutError>);
    await held.release();
  });

  it("cancels contended infinite admission without affecting the owner", async () => {
    const sessionFile = path.join(root, "session.jsonl");
    const held = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
    const abort = new AbortController();
    const reason = new Error("stop requested");
    const pending = acquireSessionWriteLock({
      sessionFile,
      timeoutMs: Number.POSITIVE_INFINITY,
      signal: abort.signal,
    });
    abort.abort(reason);

    await expect(pending).rejects.toBe(reason);
    await expect(fs.access(`${sessionFile}.lock`)).resolves.toBeUndefined();
    await held.release();
  });

  it("reclaims a definitely dead file owner", async () => {
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.lock`,
      JSON.stringify({ pid: 2_147_483_647, createdAt: new Date().toISOString() }),
    );
    const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
    await lock.release();
  });

  it("reclaims an old payload-less sidecar after the short-admission grace", async () => {
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(`${sessionFile}.lock`, "");
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(`${sessionFile}.lock`, old, old);
    const lock = await acquireSessionWriteLock({
      sessionFile,
      timeoutMs: 500,
      staleMs: 60_000,
    });
    await lock.release();
  });

  it("preserves a fresh malformed sidecar", async () => {
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(`${sessionFile}.lock`, "{}");
    await expect(
      acquireSessionWriteLock({ sessionFile, timeoutMs: 5, staleMs: 60_000 }),
    ).rejects.toBeInstanceOf(SessionWriteLockTimeoutError);
    await expect(fs.access(`${sessionFile}.lock`)).resolves.toBeUndefined();
  });

  it("reclaims an untracked same-process sidecar", async () => {
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.lock`,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    );
    const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
    await lock.release();
  });

  it("reports an old live OpenClaw owner without removing it", async () => {
    const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "openclaw"], {
      stdio: "ignore",
    });
    if (!owner.pid) {
      throw new Error("missing child pid");
    }
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.lock`,
      JSON.stringify({ pid: owner.pid, createdAt: "2000-01-01T00:00:00.000Z" }),
    );
    try {
      await expect(
        acquireSessionWriteLock({ sessionFile, timeoutMs: 500, staleMs: 1 }),
      ).rejects.toBeInstanceOf(SessionWriteLockStaleError);
      await expect(fs.access(`${sessionFile}.lock`)).resolves.toBeUndefined();
    } finally {
      owner.kill("SIGTERM");
    }
  });

  it("reclaims a live sidecar owned by a non-OpenClaw process", async () => {
    const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "worker"], {
      stdio: "ignore",
    });
    if (!owner.pid) {
      throw new Error("missing child pid");
    }
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.lock`,
      JSON.stringify({ pid: owner.pid, createdAt: new Date().toISOString() }),
    );
    try {
      const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
      await lock.release();
    } finally {
      owner.kill("SIGTERM");
    }
  });

  it("retries when a reported stale sidecar disappears before diagnostics", async () => {
    const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "openclaw"], {
      stdio: "ignore",
    });
    if (!owner.pid) {
      throw new Error("missing child pid");
    }
    const sessionFile = path.join(root, "session.jsonl");
    const lockPath = `${sessionFile}.lock`;
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: owner.pid, createdAt: "2000-01-01T00:00:00.000Z" }),
    );
    const originalReadFile = fs.readFile.bind(fs);
    let lockReads = 0;
    const readFile = vi.spyOn(fs, "readFile").mockImplementation((async (file, options) => {
      if (typeof file === "string" && path.basename(file) === path.basename(lockPath)) {
        lockReads += 1;
      }
      if (lockReads === 3) {
        await fs.rm(lockPath, { force: true });
        throw Object.assign(new Error("lock disappeared"), { code: "ENOENT" });
      }
      return await originalReadFile(file, options as never);
    }) as typeof fs.readFile);
    try {
      const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500, staleMs: 1 });
      expect(lockReads).toBeGreaterThanOrEqual(3);
      await lock.release();
    } finally {
      readFile.mockRestore();
      owner.kill("SIGTERM");
    }
  });

  it("does not reclaim a live owner based only on age", async () => {
    const sessionFile = path.join(root, "session.jsonl");
    const held = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
    await expect(
      acquireSessionWriteLock({ sessionFile, timeoutMs: 5, staleMs: 1 }),
    ).rejects.toBeInstanceOf(SessionWriteLockTimeoutError);
    await held.release();
  });

  it("delegates explicit session keys to SQLite", async () => {
    const sessionFile = JSON.stringify([
      "main",
      path.join(root, "openclaw-agent.sqlite"),
      "sdk-session",
    ]);
    const first = await acquireSessionWriteLock({ sessionFile, targetKind: "session-key" });
    await expect(
      acquireSessionWriteLock({ sessionFile, targetKind: "session-key", timeoutMs: 5 }),
    ).rejects.toBeInstanceOf(SessionWriteLockTimeoutError);
    await first.release();
  });
});
