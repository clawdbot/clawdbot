/**
 * Streaming ANSI sanitization for the local exec runtime.
 * Verifies escape sequences split across stream callbacks are consumed rather
 * than escaped into visible text, and that stdout and stderr keep independent
 * parser state.
 */
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { ManagedRun } from "../process/supervisor/index.js";
import type { SpawnInput } from "../process/supervisor/types.js";

let resetProcessRegistryForTests: typeof import("./bash-process-registry.test-support.js").resetProcessRegistryForTests;
let runExecProcess: typeof import("./bash-tools.exec-runtime.js").runExecProcess;

const { supervisorSpawnMock } = vi.hoisted(() => ({
  supervisorSpawnMock: vi.fn(),
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: supervisorSpawnMock,
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    getRecord: vi.fn(),
  }),
}));

function createRun(input: SpawnInput): ManagedRun {
  return {
    runId: input.runId ?? "test-run",
    pid: 1234,
    startedAtMs: 0,
    stdin: { write: vi.fn(), end: vi.fn(), destroy: vi.fn() },
    cancel: vi.fn(),
    wait: vi.fn(async () => ({
      reason: "exit" as const,
      exitCode: 0,
      exitSignal: null,
      durationMs: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    })),
  };
}

function runExec() {
  return runExecProcess({
    command: "printf styled",
    workdir: process.cwd(),
    env: {},
    usePty: false,
    warnings: [],
    maxOutput: 20_000,
    pendingMaxOutput: 20_000,
    notifyOnExit: false,
    timeoutSec: 5,
  });
}

beforeAll(async () => {
  ({ resetProcessRegistryForTests } = await import("./bash-process-registry.test-support.js"));
  ({ runExecProcess } = await import("./bash-tools.exec-runtime.js"));
});

beforeEach(() => {
  supervisorSpawnMock.mockReset();
});

afterEach(() => {
  resetProcessRegistryForTests();
  vi.clearAllMocks();
});

test("sanitizes ANSI and OSC sequences split across stdout chunks", async () => {
  supervisorSpawnMock.mockImplementationOnce(async (input: SpawnInput) => {
    for (const chunk of [
      "A\u001B]0;title",
      "\u0007B",
      "C\u001B[31",
      "mD",
      "E\u009D0;title",
      "\u001B\\F",
      "G\u009B31",
      "mH",
    ]) {
      input.onStdout?.(chunk);
    }
    return createRun(input);
  });

  const outcome = await (await runExec()).promise;

  expect(outcome.aggregated).toContain("ABCDEFGH");
  expect(outcome.aggregated).not.toContain("\\x1b");
});

test("sanitizes escape sequences split across stderr chunks", async () => {
  supervisorSpawnMock.mockImplementationOnce(async (input: SpawnInput) => {
    input.onStderr?.("warn: \u001B[");
    input.onStderr?.("31mred");
    return createRun(input);
  });

  const outcome = await (await runExec()).promise;

  expect(outcome.aggregated).toContain("warn: red");
  expect(outcome.aggregated).not.toContain("\\x1b");
});

test("keeps stdout and stderr parser state independent", async () => {
  supervisorSpawnMock.mockImplementationOnce(async (input: SpawnInput) => {
    // Both streams leave a sequence dangling; neither may consume the other's tail.
    input.onStdout?.("out\u001B[");
    input.onStderr?.("err\u001B[");
    input.onStdout?.("32mOUT");
    input.onStderr?.("31mERR");
    return createRun(input);
  });

  const outcome = await (await runExec()).promise;

  // Interleaved across both streams, but each stream consumed its own sequence:
  // no escape leaks, and neither colour parameter survives as visible text.
  expect(outcome.aggregated).toBe("outerrOUTERR");
});
