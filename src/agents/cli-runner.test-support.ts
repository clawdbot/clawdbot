import type { Mock } from "vitest";
import { beforeEach, vi } from "vitest";
import type { requestHeartbeat } from "../infra/heartbeat-wake.js";
import type { enqueueSystemEvent } from "../infra/system-events.js";
import type { getProcessSupervisor } from "../process/supervisor/index.js";
import { setCliRunnerExecuteTestDeps } from "./cli-runner/execute.js";
import { setCliRunnerPrepareTestDeps } from "./cli-runner/prepare.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

type ProcessSupervisor = ReturnType<typeof getProcessSupervisor>;
type SupervisorSpawnFn = ProcessSupervisor["spawn"];
type EnqueueSystemEventFn = typeof enqueueSystemEvent;
type RequestHeartbeatFn = typeof requestHeartbeat;
type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type BootstrapContext = {
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
};
type ResolveBootstrapContextForRunMock = Mock<() => Promise<BootstrapContext>>;

export const supervisorSpawnMock: UnknownMock = vi.fn();
export const enqueueSystemEventMock: UnknownMock = vi.fn();
export const requestHeartbeatMock: UnknownMock = vi.fn();

const hoisted = vi.hoisted(
  (): {
    resolveBootstrapContextForRunMock: ResolveBootstrapContextForRunMock;
  } => {
    return {
      resolveBootstrapContextForRunMock: vi.fn<() => Promise<BootstrapContext>>(async () => ({
        bootstrapFiles: [],
        contextFiles: [],
      })),
    };
  },
);

setCliRunnerExecuteTestDeps({
  getProcessSupervisor: () => ({
    spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
      supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    reconcileOrphans: vi.fn(),
    getRecord: vi.fn(),
  }),
  enqueueSystemEvent: (
    text: Parameters<EnqueueSystemEventFn>[0],
    options: Parameters<EnqueueSystemEventFn>[1],
  ) => enqueueSystemEventMock(text, options) as ReturnType<EnqueueSystemEventFn>,
  requestHeartbeat: (options?: Parameters<RequestHeartbeatFn>[0]) =>
    requestHeartbeatMock(options) as ReturnType<RequestHeartbeatFn>,
});

setCliRunnerPrepareTestDeps({
  makeBootstrapWarn: () => () => {},
  resolveBootstrapContextForRun: hoisted.resolveBootstrapContextForRunMock,
  resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
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

export function mockSuccessfulCliRun() {
  supervisorSpawnMock.mockResolvedValueOnce(
    createManagedRun({
      reason: "exit",
      exitCode: 0,
      exitSignal: null,
      durationMs: 50,
      stdout: "ok",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    }),
  );
}

export function restoreCliRunnerPrepareTestDeps() {
  setCliRunnerPrepareTestDeps({
    makeBootstrapWarn: () => () => {},
    resolveBootstrapContextForRun: hoisted.resolveBootstrapContextForRunMock,
    resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
});
