import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ManagedRun, SpawnInput } from "../process/supervisor/types.js";
import { markBackgrounded, waitForExecScope } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createAgentCleanupScope } from "./run-cleanup-timeout.js";

const supervisorMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => supervisorMock,
}));

let runExecProcess: typeof import("./bash-tools.exec-runtime.js").runExecProcess;
beforeAll(async () => {
  ({ runExecProcess } = await import("./bash-tools.exec-runtime.js"));
});
beforeEach(() => {
  resetProcessRegistryForTests();
  supervisorMock.spawn.mockReset();
});
afterEach(() => {
  resetProcessRegistryForTests();
});

function runtimeManagedRun(input: SpawnInput): ManagedRun {
  return {
    activity: { resultSettled: true, lastOutputAtMs: Date.now() },
    runId: input.runId ?? "test-run",
    pid: 1234,
    startedAtMs: Date.now(),
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

it.each([
  { fails: false, beforeJoin: false, commandCode: 0 },
  { fails: true, beforeJoin: false, commandCode: 0 },
  { fails: true, beforeJoin: true, commandCode: 0 },
  { fails: true, beforeJoin: false, commandCode: 127 },
])(
  "joins sandbox artifacts and retains cleanup failure (fails=$fails, beforeJoin=$beforeJoin, commandCode=$commandCode)",
  async ({ fails, beforeJoin, commandCode }) => {
    const finalization = createDeferred();
    const entered = createDeferred();
    const cleanupScope = createAgentCleanupScope();
    const scopeKey = "scope:sandbox-artifact-cleanup";
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => {
      const managed = runtimeManagedRun(input);
      return {
        ...managed,
        wait: async () => ({ ...(await managed.wait()), exitCode: commandCode }),
      };
    });
    let run: Awaited<ReturnType<typeof runExecProcess>> | undefined;
    const finalizeExec = vi.fn(async () => {
      entered.resolve();
      await finalization.promise;
      if (fails) {
        throw new Error("sandbox artifact cleanup failed");
      }
    });
    try {
      await cleanupScope.run(async () => {
        run = await runExecProcess({
          command: "sandbox-fixture",
          workdir: "/tmp",
          env: {},
          scopeKey,
          sandbox: {
            containerName: "fixture",
            workspaceDir: "/workspace",
            containerWorkdir: "/workspace",
            buildExecSpec: async () => ({
              argv: ["sandbox-fixture"],
              env: {},
              stdinMode: "pipe-closed",
            }),
            finalizeExec,
          },
          usePty: false,
          warnings: [],
          maxOutput: 1000,
          pendingMaxOutput: 1000,
          notifyOnExit: false,
          timeoutSec: null,
        });
        markBackgrounded(run.session);
        await entered.promise;
        if (beforeJoin) {
          finalization.resolve();
          await run.promise;
        }
        let joined = false;
        const join = waitForExecScope(scopeKey).then(() => {
          joined = true;
        });
        if (!beforeJoin) {
          await Promise.resolve();
          expect(joined).toBe(false);
          expect(run.session.finalizing).toBe(true);
          finalization.resolve();
        }
        await join;
        const outcome = await run.promise;
        expect(outcome.status).toBe(fails || commandCode !== 0 ? "failed" : "completed");
        expect(finalizeExec).toHaveBeenCalledOnce();
      });
      expect(cleanupScope.outcome).toBe(fails ? "uncertain" : "closed");
    } finally {
      finalization.resolve();
      await run?.promise;
    }
  },
);
