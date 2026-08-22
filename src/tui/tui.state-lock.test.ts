import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { acquireGatewayLock, type GatewayLockOptions } from "../infra/gateway-lock.js";
import { withEmbeddedTuiStateLock } from "./tui.js";

function createGatewayLockOptions(stateDir: string): GatewayLockOptions {
  return {
    allowInTests: true,
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: stateDir,
    },
    lockDir: path.join(stateDir, "gateway-locks"),
    readProcessStartTime: () => 123_456,
    timeoutMs: 100,
  };
}

function createSignalProcess() {
  type SignalName = "SIGINT" | "SIGTERM";
  const listeners = new Map<SignalName, Set<() => void>>();
  const processLike = {
    on(signal: SignalName, handler: () => void) {
      const current = listeners.get(signal) ?? new Set<() => void>();
      current.add(handler);
      listeners.set(signal, current);
      return processLike;
    },
    off(signal: SignalName, handler: () => void) {
      listeners.get(signal)?.delete(handler);
      return processLike;
    },
  };
  return {
    processLike,
    emit(signal: SignalName) {
      for (const handler of listeners.get(signal) ?? []) {
        handler();
      }
    },
  };
}

async function withTempState<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tui-state-lock-"));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("embedded TUI state ownership", () => {
  it("refuses local startup while a live Gateway owns the state directory", async () => {
    await withTempState(async (stateDir) => {
      const lockOptions = createGatewayLockOptions(stateDir);
      const gatewayLock = await acquireGatewayLock({ ...lockOptions, port: 28789 });
      expect(gatewayLock).not.toBeNull();
      if (!gatewayLock) {
        throw new Error("Expected live Gateway fixture lock");
      }
      const run = vi.fn(async () => undefined);
      try {
        await expect(
          withEmbeddedTuiStateLock(run, { gatewayLockOptions: lockOptions }),
        ).rejects.toThrow(
          `A Gateway is running for this state directory (pid ${process.pid}, port 28789). Run without --local to use it, or stop the Gateway first (openclaw gateway stop).`,
        );
        expect(run).not.toHaveBeenCalled();
      } finally {
        await gatewayLock.release();
      }
    });
  });

  it("holds and releases embedded state ownership for the local TUI lifetime", async () => {
    await withTempState(async (stateDir) => {
      const lockOptions = createGatewayLockOptions(stateDir);
      const stateLockPath = path.join(lockOptions.lockDir!, "gateway.state.lock");

      await withEmbeddedTuiStateLock(
        async () => {
          const payload = JSON.parse(await fs.readFile(stateLockPath, "utf8")) as {
            pid?: number;
            role?: string;
          };
          expect(payload).toMatchObject({ pid: process.pid, role: "agent-embedded" });
        },
        { gatewayLockOptions: lockOptions },
      );

      await expect(fs.stat(stateLockPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("releases embedded state ownership when the local TUI receives SIGTERM", async () => {
    await withTempState(async (stateDir) => {
      const lockOptions = createGatewayLockOptions(stateDir);
      const stateLockPath = path.join(lockOptions.lockDir!, "gateway.state.lock");
      const signals = createSignalProcess();
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const run = withEmbeddedTuiStateLock(
        async (signal) => {
          markStarted();
          return await new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("local TUI interrupted")), {
              once: true,
            });
          });
        },
        { gatewayLockOptions: lockOptions, process: signals.processLike },
      );
      await started;
      signals.emit("SIGTERM");

      await expect(run).rejects.toThrow("local TUI interrupted");
      await expect(fs.stat(stateLockPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
