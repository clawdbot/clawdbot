import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_READY_OUTPUT_MAX_CHARS,
  hasChildExited,
  parseArgs,
  readNumber,
  readPositiveNumber,
  stopGatewayWithRuntime,
  updateGatewayReadyOutputState,
  waitForGatewayReady,
} from "../../scripts/check-memory-fd-repro.mjs";

function withEnv<T>(env: Record<string, string | undefined>, callback: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("check-memory-fd-repro", () => {
  it("parses file, fd, and timing limits as strict integers", () => {
    expect(readNumber("0", "limit")).toBe(0);
    expect(readNumber(" 42 ", "limit")).toBe(42);
    expect(readPositiveNumber("1", "limit")).toBe(1);

    expect(() => readNumber("1.5", "limit")).toThrow("limit must be a non-negative integer");
    expect(() => readNumber("1e3", "limit")).toThrow("limit must be a non-negative integer");
    expect(() => readNumber("10files", "limit")).toThrow("limit must be a non-negative integer");
    expect(() => readPositiveNumber("0", "limit")).toThrow("limit must be greater than 0");
  });

  it("rejects loose numeric environment limits before generating files", () => {
    expect(
      withEnv(
        {
          OPENCLAW_MEMORY_FD_REPRO_FILES: "17",
          OPENCLAW_MEMORY_FD_REPRO_MAX_WORKSPACE_REG_FDS: "0",
          OPENCLAW_MEMORY_FD_REPRO_SAMPLE_DELAY_MS: "0",
        },
        () => parseArgs([]),
      ),
    ).toMatchObject({
      fileCount: 17,
      maxWorkspaceRegFds: 0,
      sampleDelayMs: 0,
    });

    expect(() =>
      withEnv({ OPENCLAW_MEMORY_FD_REPRO_FILES: "17files" }, () => parseArgs([])),
    ).toThrow("OPENCLAW_MEMORY_FD_REPRO_FILES must be a non-negative integer");
    expect(() =>
      withEnv({ OPENCLAW_MEMORY_FD_REPRO_TIMEOUT_MS: "1e3" }, () => parseArgs([])),
    ).toThrow("OPENCLAW_MEMORY_FD_REPRO_TIMEOUT_MS must be a non-negative integer");
  });

  it("lets explicit CLI numeric flags override malformed inherited env defaults", () => {
    expect(
      withEnv(
        {
          OPENCLAW_MEMORY_FD_REPRO_FILES: "17files",
          OPENCLAW_MEMORY_FD_REPRO_MAX_WORKSPACE_REG_FDS: "4fds",
          OPENCLAW_MEMORY_FD_REPRO_TIMEOUT_MS: "1e3",
          OPENCLAW_MEMORY_FD_REPRO_SAMPLE_DELAY_MS: "soon",
          OPENCLAW_MEMORY_FD_REPRO_SETTLE_DELAY_MS: "later",
        },
        () =>
          parseArgs([
            "--files",
            "20",
            "--max-workspace-reg-fds",
            "4",
            "--invoke-timeout-ms",
            "1000",
            "--sample-delay-ms",
            "0",
            "--settle-delay-ms",
            "0",
          ]),
      ),
    ).toMatchObject({
      fileCount: 20,
      invokeTimeoutMs: 1000,
      maxWorkspaceRegFds: 4,
      sampleDelayMs: 0,
      settleDelayMs: 0,
    });
  });

  it("treats signaled gateway children as exited", () => {
    expect(hasChildExited({ exitCode: null, signalCode: "SIGTERM" })).toBe(true);
    expect(hasChildExited({ exitCode: 0, signalCode: null })).toBe(true);
    expect(hasChildExited({ exitCode: null, signalCode: null })).toBe(false);
  });

  it("fails gateway readiness immediately after signal exits", async () => {
    const child = {
      exitCode: null,
      signalCode: "SIGTERM",
      stderr: new EventEmitter(),
      stdout: new EventEmitter(),
    };

    await expect(
      waitForGatewayReady({ child, port: 9, logPath: "gateway.log", timeoutMs: 10_000 }),
    ).rejects.toThrow("gateway exited before ready");
  });

  it("does not signal already exited children during gateway cleanup", async () => {
    const child = {
      exitCode: null,
      kill: vi.fn(),
      signalCode: "SIGTERM",
    };
    const findGatewayPidFn = vi.fn(() => null);
    const killProcess = vi.fn();

    await expect(
      stopGatewayWithRuntime({ child, findGatewayPidFn, killProcess, port: 9 }),
    ).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
    expect(findGatewayPidFn).toHaveBeenCalledWith(9);
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("bounds gateway readiness output while keeping newest logs", () => {
    const first = updateGatewayReadyOutputState({ tail: "abc", readySeen: false }, "def", 8);
    expect(first).toEqual({ tail: "abcdef", readySeen: false });

    const second = updateGatewayReadyOutputState(first, "ghijkl", 8);
    expect(second).toEqual({ tail: "efghijkl", readySeen: false });
    expect(second.tail).toHaveLength(8);
    expect(GATEWAY_READY_OUTPUT_MAX_CHARS).toBeGreaterThan(1024);
  });

  it("keeps readiness after a coalesced noisy chunk truncates the marker", () => {
    const state = updateGatewayReadyOutputState(
      { tail: "", readySeen: false },
      `[gateway] ready\n${"x".repeat(10_000)}`,
      64,
    );

    expect(state.readySeen).toBe(true);
    expect(state.tail).toHaveLength(64);
    expect(state.tail).not.toContain("[gateway] ready");
  });

  it("recognizes readiness split across the existing tail and new chunk", () => {
    const state = updateGatewayReadyOutputState(
      { tail: "[gateway] rea", readySeen: false },
      "dy\n",
      64,
    );

    expect(state.readySeen).toBe(true);
    expect(state.tail).toBe("[gateway] ready\n");
  });

  it("preserves previous readiness once seen", () => {
    const state = updateGatewayReadyOutputState({ tail: "old", readySeen: true }, "new output", 8);

    expect(state.readySeen).toBe(true);
    expect(state.tail).toBe("w output");
  });
});
