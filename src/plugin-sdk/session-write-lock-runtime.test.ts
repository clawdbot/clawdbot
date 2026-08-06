import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionWriteLockStaleError,
  SessionWriteLockTimeoutError,
} from "../agents/session-write-lock-error.js";
import { drainSessionWriteLockStateForTest } from "../agents/session-write-lock.js";
import { readSessionLockProcessStartTime } from "../infra/session-lock-file-inspection.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  acquireSessionWriteLock,
  drainSessionFileWriteLockStateForTest,
} from "./session-write-lock-runtime.js";

const CLEANUP_SIGNALS = ["SIGINT", "SIGTERM", "SIGQUIT", "SIGABRT"] as const;

function addedSignalListener(
  signal: (typeof CLEANUP_SIGNALS)[number],
  before: Set<(...args: unknown[]) => void>,
): (() => void) | undefined {
  return process
    .listeners(signal)
    .find((listener) => !before.has(listener as (...args: unknown[]) => void)) as
    | (() => void)
    | undefined;
}

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

  for (const signal of CLEANUP_SIGNALS) {
    it(`synchronously releases sidecars for ${signal} without removing peer listeners`, async () => {
      const sessionFile = path.join(root, `${signal}.jsonl`);
      const peer = () => {};
      process.on(signal, peer);
      const before = new Set(process.listeners(signal) as Array<(...args: unknown[]) => void>);
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);
      try {
        await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
        const cleanup = addedSignalListener(signal, before);
        expect(cleanup).toBeDefined();

        cleanup?.();

        await expect(fs.access(`${sessionFile}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
        await drainSessionFileWriteLockStateForTest();
        expect(new Set(process.listeners(signal))).toEqual(before);
        expect(kill).not.toHaveBeenCalled();
      } finally {
        kill.mockRestore();
        process.off(signal, peer);
      }
    });
  }

  it("does not accumulate cleanup listeners across drain cycles", async () => {
    const prime = await acquireSessionWriteLock({
      sessionFile: path.join(root, "listener-prime.jsonl"),
      timeoutMs: 500,
    });
    await prime.release();
    await drainSessionFileWriteLockStateForTest();
    const signalCounts = CLEANUP_SIGNALS.map((signal) => process.listenerCount(signal));
    const exitCount = process.listenerCount("exit");

    for (let cycle = 0; cycle < 2; cycle += 1) {
      const lock = await acquireSessionWriteLock({
        sessionFile: path.join(root, `listener-${cycle}.jsonl`),
        timeoutMs: 500,
      });
      await lock.release();
      await drainSessionFileWriteLockStateForTest();
    }

    expect(CLEANUP_SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(signalCounts);
    expect(process.listenerCount("exit")).toBe(exitCount);
  });

  it("reraises a sole termination signal after synchronous cleanup", async () => {
    const signal = "SIGTERM";
    const before = new Set(process.listeners(signal) as Array<(...args: unknown[]) => void>);
    const sessionFile = path.join(root, "sole-signal.jsonl");
    await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
    const cleanup = addedSignalListener(signal, before);
    const listenerCount = vi.spyOn(process, "listenerCount").mockReturnValue(1);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      cleanup?.();

      await expect(fs.access(`${sessionFile}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
      expect(kill).toHaveBeenCalledWith(process.pid, signal);
    } finally {
      listenerCount.mockRestore();
      kill.mockRestore();
    }
  });

  it("removes sidecars during real process exit", async () => {
    const sessionFile = path.join(root, "process-exit.jsonl");
    const runtimeUrl = pathToFileURL(
      path.resolve("src/plugin-sdk/session-write-lock-runtime.ts"),
    ).href;
    const script = `
      import fs from "node:fs/promises";
      import { acquireSessionWriteLock } from ${JSON.stringify(runtimeUrl)};
      const sessionFile = ${JSON.stringify(sessionFile)};
      await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
      await fs.access(sessionFile + ".lock");
      process.exit(0);
    `;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { encoding: "utf8", timeout: 10_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    await expect(fs.access(`${sessionFile}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("watchdog expiry releases only the lock it owns", async () => {
    vi.useFakeTimers();
    vi.stubEnv("VITEST", "false");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sessionFile = path.join(root, "watchdog.jsonl");
    try {
      const expired = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500, maxHoldMs: 1 });
      await vi.advanceTimersByTimeAsync(60_001);
      vi.useRealTimers();
      await expect
        .poll(
          async () => {
            try {
              await fs.access(`${sessionFile}.lock`);
              return false;
            } catch {
              return true;
            }
          },
          { timeout: 1_000 },
        )
        .toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("[session-write-lock] releasing lock held for"),
      );

      const successor = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
      await expired.release();
      await expect(fs.access(`${sessionFile}.lock`)).resolves.toBeUndefined();
      await successor.release();
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      warn.mockRestore();
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
    const sessionFile = path.join(await fs.realpath(root), "session.jsonl");
    const held = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
    const lockPath = `${sessionFile}.lock`;
    let observedContention: (() => void) | undefined;
    const contention = new Promise<void>((resolve) => {
      observedContention = resolve;
    });
    // fs-safe 0.5.2 polls contended sidecars via lstat/open descriptors, not
    // readFile; observe contention at the lstat seam.
    const originalLstat = fs.lstat.bind(fs);
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation((async (file, options) => {
      if (file === lockPath) {
        observedContention?.();
      }
      return await originalLstat(file, options as never);
    }) as typeof fs.lstat);
    const abort = new AbortController();
    const reason = new Error("stop requested");
    try {
      const pending = acquireSessionWriteLock({
        sessionFile,
        timeoutMs: Number.POSITIVE_INFINITY,
        signal: abort.signal,
      });
      const rejected = expect(pending).rejects.toBe(reason);
      await contention;
      abort.abort(reason);

      await expect(fs.access(lockPath)).resolves.toBeUndefined();
      await held.release();
      await rejected;
      const successor = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
      await successor.release();
      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      lstatSpy.mockRestore();
      await held.release();
    }
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

  it.runIf(process.platform === "linux")(
    "emits process starttime and reclaims a recycled-pid sidecar",
    async () => {
      const starttime = readSessionLockProcessStartTime(process.pid);
      expect(starttime).not.toBeNull();
      const sessionFile = path.join(root, "recycled-pid.jsonl");
      await fs.writeFile(
        `${sessionFile}.lock`,
        JSON.stringify({
          pid: process.pid,
          starttime: (starttime ?? 0) + 1,
          createdAt: new Date().toISOString(),
        }),
      );

      const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
      const payload = JSON.parse(await fs.readFile(`${sessionFile}.lock`, "utf8")) as {
        pid: number;
        starttime: number;
      };
      expect(payload).toMatchObject({ pid: process.pid, starttime });
      await lock.release();
    },
  );

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
    // fs-safe 0.5.2 reads sidecar payloads through pinned descriptors; the
    // adapter's stale diagnostics are the only readFile consumer left. Vanish
    // the sidecar on that first diagnostics read so the retry path is taken.
    const readFile = vi.spyOn(fs, "readFile").mockImplementation((async (file, options) => {
      if (typeof file === "string" && path.basename(file) === path.basename(lockPath)) {
        lockReads += 1;
        await fs.rm(lockPath, { force: true });
        throw Object.assign(new Error("lock disappeared"), { code: "ENOENT" });
      }
      return await originalReadFile(file, options as never);
    }) as typeof fs.readFile);
    try {
      const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500, staleMs: 1 });
      expect(lockReads).toBeGreaterThanOrEqual(1);
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
