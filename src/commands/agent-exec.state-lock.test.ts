import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireGatewayLock, type GatewayLockOptions } from "../infra/gateway-lock.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentExecCommand } from "./agent-exec.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createRuntime() {
  const error = vi.fn();
  const runtime: RuntimeEnv = { log: vi.fn(), error, exit: vi.fn() };
  return { runtime, error };
}

function successResult() {
  return {
    payloads: [{ text: "done" }],
    meta: {
      durationMs: 1,
      agentMeta: { sessionId: "session-result", provider: "openai", model: "gpt-5.6-sol" },
    },
  };
}

function createGatewayLockOptions(
  stateDir: string,
  overrides: Partial<GatewayLockOptions> = {},
): GatewayLockOptions {
  return {
    allowInTests: true,
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: stateDir,
    },
    lockDir: path.join(stateDir, "gateway-locks"),
    timeoutMs: 100,
    ...overrides,
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

describe("agent exec retained-state ownership", () => {
  it("refuses a state directory owned by a live Gateway", async () => {
    const stateDir = tempDirs.make("openclaw-agent-exec-gateway-owner-");
    const lockOptions = createGatewayLockOptions(stateDir, {
      readProcessStartTime: () => 123_456,
    });
    const gatewayLock = await acquireGatewayLock({ ...lockOptions, port: 28789 });
    expect(gatewayLock).not.toBeNull();
    if (!gatewayLock) {
      throw new Error("Expected live Gateway fixture lock");
    }
    const runAgent = vi.fn(async () => successResult());
    const { runtime, error } = createRuntime();

    try {
      const result = await agentExecCommand("inspect", { stateDir }, runtime, {
        gatewayLockOptions: lockOptions,
        runAgent,
      });
      expect(result.exitCode).toBe(1);
      expect(runAgent).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        `A Gateway is running for this state directory (pid ${process.pid}, port 28789). Omit --state-dir to use isolated temporary state, or stop the Gateway first (openclaw gateway stop).`,
      );
    } finally {
      await gatewayLock.release();
    }
  });

  it("holds and releases the embedded state lock around the run", async () => {
    const stateDir = tempDirs.make("openclaw-agent-exec-lock-owner-");
    const lockOptions = createGatewayLockOptions(stateDir);
    const stateLockPath = path.join(lockOptions.lockDir!, "gateway.state.lock");

    await agentExecCommand("inspect", { stateDir }, createRuntime().runtime, {
      gatewayLockOptions: lockOptions,
      runAgent: vi.fn(async () => {
        const payload = JSON.parse(await fs.readFile(stateLockPath, "utf8")) as {
          pid?: number;
          role?: string;
        };
        expect(payload).toMatchObject({ pid: process.pid, role: "agent-embedded" });
        return successResult();
      }),
    });

    await expect(fs.stat(stateLockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases the embedded state lock when SIGTERM aborts the run", async () => {
    const stateDir = tempDirs.make("openclaw-agent-exec-signal-owner-");
    const lockOptions = createGatewayLockOptions(stateDir);
    const stateLockPath = path.join(lockOptions.lockDir!, "gateway.state.lock");
    const signals = createSignalProcess();
    const { runtime } = createRuntime();
    const runAgent = vi.fn(async (opts: Record<string, unknown>) => {
      const signal = opts.abortSignal as AbortSignal;
      return await new Promise<ReturnType<typeof successResult>>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            const error = new Error("agent exec aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    });

    const run = agentExecCommand("inspect", { stateDir }, runtime, {
      gatewayLockOptions: lockOptions,
      process: signals.processLike,
      runAgent,
    });
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledOnce());
    signals.emit("SIGTERM");
    await run;

    await expect(fs.stat(stateLockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(runtime.exit).toHaveBeenCalledWith(143, { resetStream: process.stderr });
  });
});
