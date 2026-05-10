import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { killProcessTree } from "../process/kill-tree.js";

const supervisorMockState = vi.hoisted(() => ({
  cancelReasons: [] as Array<"manual-cancel" | "overall-timeout">,
  spawnInputs: [] as Array<{ timeoutMs?: number }>,
}));

vi.mock("../process/supervisor/index.js", () => {
  let counter = 0;
  return {
    getProcessSupervisor: () => ({
      spawn: async (input: { timeoutMs?: number }) => {
        supervisorMockState.spawnInputs.push(input);
        const runId = `mock-run-${++counter}`;
        let settled = false;
        let settle = (_reason: "manual-cancel" | "overall-timeout", _timedOut: boolean) => {};
        const waitPromise = new Promise<{
          reason: "manual-cancel" | "overall-timeout";
          exitCode: number | null;
          exitSignal: NodeJS.Signals | number | null;
          durationMs: number;
          stdout: string;
          stderr: string;
          timedOut: boolean;
          noOutputTimedOut: boolean;
        }>((resolve) => {
          settle = (reason, timedOut) => {
            if (settled) {
              return;
            }
            settled = true;
            resolve({
              reason,
              exitCode: null,
              exitSignal: null,
              durationMs: input.timeoutMs ?? 0,
              stdout: "",
              stderr: "",
              timedOut,
              noOutputTimedOut: false,
            });
          };
          if (input.timeoutMs !== undefined) {
            setTimeout(() => settle("overall-timeout", true), 12);
          }
        });
        return {
          runId,
          startedAtMs: Date.now(),
          stdin: undefined,
          wait: () => waitPromise,
          cancel: () => {
            supervisorMockState.cancelReasons.push("manual-cancel");
            settle("manual-cancel", false);
          },
        };
      },
      cancel: vi.fn(),
      cancelScope: vi.fn(),
      reconcileOrphans: vi.fn(),
      getRecord: vi.fn(),
    }),
  };
});

vi.mock("../infra/shell-env.js", () => ({
  getShellPathFromLoginShell: vi.fn(() => null),
  resolveShellEnvFallbackTimeoutMs: vi.fn(() => 0),
}));

vi.mock("./bash-tools.exec-host-gateway.js", () => ({
  processGatewayAllowlist: vi.fn(async () => ({})),
}));

vi.mock("./bash-tools.exec-host-node.js", () => ({
  executeNodeHostCommand: vi.fn(async () => {
    throw new Error("node host not expected in background abort tests");
  }),
}));

const BACKGROUND_HOLD_CMD =
  process.platform === "win32" ? 'node -e "setTimeout(() => {}, 1000)"' : "exec sleep 1";
const ABORT_SETTLE_MS = process.platform === "win32" ? 200 : 0;
const POLL_INTERVAL_MS = process.platform === "win32" ? 15 : 5;
const FINISHED_WAIT_TIMEOUT_MS = process.platform === "win32" ? 8_000 : 1_000;
const BACKGROUND_TIMEOUT_SEC = process.platform === "win32" ? 0.2 : 0.02;
const TEST_EXEC_DEFAULTS = {
  host: "gateway" as const,
  security: "full" as const,
  ask: "off" as const,
};

let createExecTool: typeof import("./bash-tools.exec.js").createExecTool;
let getFinishedSession: typeof import("./bash-process-registry.js").getFinishedSession;
let getSession: typeof import("./bash-process-registry.js").getSession;
let resetProcessRegistryForTests: typeof import("./bash-process-registry.js").resetProcessRegistryForTests;
type ExecToolExecuteParams = Parameters<ReturnType<typeof createExecTool>["execute"]>[1];

const createTestExecTool = (
  defaults?: Parameters<typeof createExecTool>[0],
): ReturnType<typeof createExecTool> => createExecTool({ ...TEST_EXEC_DEFAULTS, ...defaults });

beforeAll(async () => {
  ({ createExecTool } = await import("./bash-tools.exec.js"));
  ({ getFinishedSession, getSession, resetProcessRegistryForTests } =
    await import("./bash-process-registry.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  supervisorMockState.cancelReasons.length = 0;
  supervisorMockState.spawnInputs.length = 0;
});

afterEach(() => {
  resetProcessRegistryForTests();
});

async function waitForFinishedSession(sessionId: string) {
  let finished = getFinishedSession(sessionId);
  await expect
    .poll(
      () => {
        finished = getFinishedSession(sessionId);
        return Boolean(finished);
      },
      {
        timeout: FINISHED_WAIT_TIMEOUT_MS,
        interval: POLL_INTERVAL_MS,
      },
    )
    .toBe(true);
  return finished;
}

function cleanupRunningSession(sessionId: string) {
  const running = getSession(sessionId);
  const pid = running?.pid;
  if (pid) {
    killProcessTree(pid);
  }
  return running;
}

async function expectBackgroundSessionSurvivesAbort(params: {
  tool: ReturnType<typeof createExecTool>;
  executeParams: ExecToolExecuteParams;
}) {
  const abortController = new AbortController();
  const result = await params.tool.execute(
    "toolcall",
    params.executeParams,
    abortController.signal,
  );
  expect(result.details.status).toBe("running");
  const sessionId = (result.details as { sessionId: string }).sessionId;

  abortController.abort();
  if (ABORT_SETTLE_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, ABORT_SETTLE_MS));
  }

  const running = getSession(sessionId);
  const finished = getFinishedSession(sessionId);
  try {
    expect(supervisorMockState.cancelReasons).toStrictEqual([]);
    expect(finished).toBeUndefined();
    expect(running?.exited).toBe(false);
  } finally {
    cleanupRunningSession(sessionId);
  }
}

async function expectBackgroundSessionTimesOut(params: {
  tool: ReturnType<typeof createExecTool>;
  executeParams: ExecToolExecuteParams;
  signal?: AbortSignal;
  abortAfterStart?: boolean;
  expectedTimeoutSec?: number;
}) {
  const abortController = new AbortController();
  const signal = params.signal ?? abortController.signal;
  const result = await params.tool.execute("toolcall", params.executeParams, signal);
  expect(result.details.status).toBe("running");
  const sessionId = (result.details as { sessionId: string }).sessionId;
  if (typeof params.expectedTimeoutSec === "number") {
    expect(supervisorMockState.spawnInputs.at(-1)?.timeoutMs).toBe(
      Math.floor(params.expectedTimeoutSec * 1000),
    );
  }

  if (params.abortAfterStart) {
    abortController.abort();
  }

  const finished = await waitForFinishedSession(sessionId);
  try {
    expect(finished?.status).toBe("failed");
  } finally {
    cleanupRunningSession(sessionId);
  }
}

test("background exec is not killed when tool signal aborts", async () => {
  const tool = createTestExecTool({ allowBackground: true, backgroundMs: 0 });
  await expectBackgroundSessionSurvivesAbort({
    tool,
    executeParams: { command: BACKGROUND_HOLD_CMD, background: true },
  });
});

test("pty background exec is not killed when tool signal aborts", async () => {
  const tool = createTestExecTool({ allowBackground: true, backgroundMs: 0 });
  await expectBackgroundSessionSurvivesAbort({
    tool,
    executeParams: { command: BACKGROUND_HOLD_CMD, background: true, pty: true },
  });
});

test("background exec still times out after tool signal abort", async () => {
  const tool = createTestExecTool({ allowBackground: true, backgroundMs: 0 });
  await expectBackgroundSessionTimesOut({
    tool,
    executeParams: {
      command: BACKGROUND_HOLD_CMD,
      background: true,
      timeout: BACKGROUND_TIMEOUT_SEC,
    },
    abortAfterStart: true,
    expectedTimeoutSec: BACKGROUND_TIMEOUT_SEC,
  });
});

test("background exec without explicit timeout applies default timeout", async () => {
  const tool = createTestExecTool({
    allowBackground: true,
    backgroundMs: 0,
    timeoutSec: BACKGROUND_TIMEOUT_SEC,
  });
  await expectBackgroundSessionTimesOut({
    tool,
    executeParams: { command: BACKGROUND_HOLD_CMD, background: true },
    expectedTimeoutSec: BACKGROUND_TIMEOUT_SEC,
  });
});

test("background exec with timeout zero bypasses default timeout", async () => {
  const tool = createTestExecTool({
    allowBackground: true,
    backgroundMs: 0,
    timeoutSec: BACKGROUND_TIMEOUT_SEC,
  });
  const result = await tool.execute("toolcall", {
    command: BACKGROUND_HOLD_CMD,
    background: true,
    timeout: 0,
  });
  expect(result.details.status).toBe("running");
  const sessionId = (result.details as { sessionId: string }).sessionId;
  expect(supervisorMockState.spawnInputs.at(-1)?.timeoutMs).toBeUndefined();
  expect(getFinishedSession(sessionId)).toBeUndefined();
  expect(getSession(sessionId)?.exited).toBe(false);

  cleanupRunningSession(sessionId);
});

test("yielded background exec still times out", async () => {
  const tool = createTestExecTool({ allowBackground: true, backgroundMs: 10 });
  await expectBackgroundSessionTimesOut({
    tool,
    executeParams: {
      command: BACKGROUND_HOLD_CMD,
      yieldMs: 5,
      timeout: BACKGROUND_TIMEOUT_SEC,
    },
    expectedTimeoutSec: BACKGROUND_TIMEOUT_SEC,
  });
});

test("yieldMs exec without explicit timeout applies default timeout", async () => {
  const tool = createTestExecTool({
    allowBackground: true,
    backgroundMs: 10,
    timeoutSec: BACKGROUND_TIMEOUT_SEC,
  });
  await expectBackgroundSessionTimesOut({
    tool,
    executeParams: {
      command: BACKGROUND_HOLD_CMD,
      yieldMs: 5,
    },
    expectedTimeoutSec: BACKGROUND_TIMEOUT_SEC,
  });
});
