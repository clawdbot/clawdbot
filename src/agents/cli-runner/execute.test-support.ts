/** Test doubles and setup for CLI execution supervisor and event seams. */
import type { Mock } from "vitest";
import { vi } from "vitest";
import type { requestHeartbeat } from "../../infra/heartbeat-wake.js";
import type { enqueueSystemEvent } from "../../infra/system-events.js";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import { executeDeps } from "./execute-deps.js";
export { buildCliExecLogLine } from "./execute-logging.js";

type ProcessSupervisor = ReturnType<typeof getProcessSupervisor>;
type SupervisorSpawnFn = ProcessSupervisor["spawn"];
type EnqueueSystemEventFn = typeof enqueueSystemEvent;
type RequestHeartbeatFn = typeof requestHeartbeat;
type UnknownMock = Mock<(...args: unknown[]) => unknown>;

export function setCliRunnerExecuteTestDeps(overrides: Partial<typeof executeDeps>): void {
  Object.assign(executeDeps, overrides);
}

export const supervisorSpawnMock: UnknownMock = vi.fn();
export const enqueueSystemEventMock: UnknownMock = vi.fn();
export const requestHeartbeatMock: UnknownMock = vi.fn();

setCliRunnerExecuteTestDeps({
  getProcessSupervisor: () => {
    const activeRuns = new Map<string, Awaited<ReturnType<SupervisorSpawnFn>>>();
    return {
      spawn: async (params: Parameters<SupervisorSpawnFn>[0]) => {
        let stdoutDelivered = false;
        let stderrDelivered = false;
        // Supervisor tests sometimes return captured output even when streaming
        // was requested; replay it through callbacks once to match production.
        const wrappedParams = {
          ...params,
          onStdout: params.onStdout
            ? (chunk: string) => {
                stdoutDelivered = true;
                params.onStdout?.(chunk);
              }
            : undefined,
          onStderr: params.onStderr
            ? (chunk: string) => {
                stderrDelivered = true;
                params.onStderr?.(chunk);
              }
            : undefined,
        };
        const managedRun = (await supervisorSpawnMock(wrappedParams)) as Awaited<
          ReturnType<SupervisorSpawnFn>
        >;
        activeRuns.set(params.runId ?? managedRun.runId, managedRun);
        const wait = managedRun.wait;
        return {
          ...managedRun,
          wait: async () => {
            const exit = await wait();
            if (params.captureOutput === false) {
              // Production streams stdout/stderr through callbacks; replay captured
              // output once so tests cover streaming and captured-output paths.
              if (!stdoutDelivered && exit.stdout) {
                params.onStdout?.(exit.stdout);
              }
              if (!stderrDelivered && exit.stderr) {
                params.onStderr?.(exit.stderr);
              }
            }
            return exit;
          },
        };
      },
      cancel: vi.fn((runId: string, reason?: Parameters<ProcessSupervisor["cancel"]>[1]) => {
        activeRuns.get(runId)?.cancel(reason);
      }),
      cancelScope: vi.fn(),
      getRecord: vi.fn(),
    };
  },
  enqueueSystemEvent: (
    text: Parameters<EnqueueSystemEventFn>[0],
    options: Parameters<EnqueueSystemEventFn>[1],
  ) => enqueueSystemEventMock(text, options) as ReturnType<EnqueueSystemEventFn>,
  requestHeartbeat: (options?: Parameters<RequestHeartbeatFn>[0]) =>
    requestHeartbeatMock(options) as ReturnType<RequestHeartbeatFn>,
});

type MockRunExit = {
  reason:
    | "manual-cancel"
    | "overall-timeout"
    | "no-output-timeout"
    | "spawn-error"
    | "signal"
    | "exit";
  exitCode: number | null;
  exitSignal: NodeJS.Signals | number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  noOutputTimedOut: boolean;
};

type ManagedRunMock = {
  runId: string;
  pid: number;
  startedAtMs: number;
  stdin: undefined;
  wait: Mock<() => Promise<MockRunExit>>;
  cancel: Mock<() => void>;
};

/** Build a managed-run mock returned by the process supervisor test double. */
export function createManagedRun(
  exit: MockRunExit,
  pid = 1234,
): ManagedRunMock & Awaited<ReturnType<SupervisorSpawnFn>> {
  return {
    runId: "run-supervisor",
    pid,
    startedAtMs: Date.now(),
    stdin: undefined,
    wait: vi.fn().mockResolvedValue(exit),
    cancel: vi.fn(),
  };
}
