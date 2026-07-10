import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../cron/types.js";
import {
  createCronExitWatchers,
  type CronExitResult,
  resolveExitWatchShell,
} from "./cron-exit-watchers.js";

type Deferred = {
  resolve: (exit: { exitCode: number | null; reason: string }) => void;
  reject: (err: unknown) => void;
};

type FireOnExit = (job: CronJob, exit: CronExitResult) => Promise<void>;

/**
 * Minimal fake ProcessSupervisor: each spawn returns a run whose wait() is
 * controlled by the test, so we can deterministically drive "command exited".
 */
function makeFakeSupervisor(opts: { deferSpawn?: boolean } = {}) {
  const runs: { scopeKey?: string; runId: string; deferred: Deferred; cancelled: boolean }[] = [];
  const cancelledScopes: string[] = [];
  const runCancels: string[] = [];
  let counter = 0;
  let releaseSpawn: (() => void) | undefined;
  const spawnGate = opts.deferSpawn
    ? new Promise<void>((res) => {
        releaseSpawn = res;
      })
    : Promise.resolve();
  const supervisor = {
    spawn: vi.fn(async (input: { scopeKey?: string }) => {
      await spawnGate;
      counter += 1;
      const runId = `run-${counter}`;
      let resolveWait!: (exit: { exitCode: number | null; reason: string }) => void;
      let rejectWait!: (err: unknown) => void;
      const waitPromise = new Promise<{ exitCode: number | null; reason: string }>((res, rej) => {
        resolveWait = res;
        rejectWait = rej;
      });
      // Pre-attach a no-op catch so a test-driven rejection never escapes as an
      // unhandled rejection if the run loses ownership before it awaits wait().
      waitPromise.catch(() => {});
      const entry = {
        scopeKey: input.scopeKey,
        runId,
        deferred: { resolve: resolveWait, reject: rejectWait },
        cancelled: false,
      };
      runs.push(entry);
      return {
        runId,
        startedAtMs: 0,
        wait: () =>
          waitPromise.then((e) => ({
            ...e,
            exitSignal: null,
            durationMs: 1,
            stdout: "",
            stderr: "",
            timedOut: false,
            noOutputTimedOut: false,
          })),
        cancel: () => {
          entry.cancelled = true;
          runCancels.push(runId);
        },
      };
    }),
    cancelScope: vi.fn((scopeKey: string) => {
      cancelledScopes.push(scopeKey);
    }),
  };
  return {
    supervisor,
    runs,
    cancelled: cancelledScopes,
    cancelledScopes,
    runCancels,
    releaseSpawn: () => releaseSpawn?.(),
  };
}

function onExitJob(id: string, command = "true", enabled = true): CronJob {
  return {
    id,
    name: id,
    enabled,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "on-exit", command },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "done" },
    delivery: { mode: "none" },
    state: {},
  } as unknown as CronJob;
}

const noopLogger = { info: () => {}, warn: () => {} };

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("createCronExitWatchers", () => {
  it("arms a watcher for an enabled on-exit job and fires the job on exit", async () => {
    const { supervisor, runs } = makeFakeSupervisor();
    const order: string[] = [];
    const persistCompletion = vi.fn(async () => {
      order.push("persist");
    });
    const fireOnExit = vi.fn(async (_job: CronJob, _exit: CronExitResult) => {
      order.push("fire");
    });
    const w = createCronExitWatchers({
      getProcessSupervisor: () => supervisor as never,
      persistCompletion,
      fireOnExit,
      logger: noopLogger,
    });

    w.reconcile([onExitJob("job-a")]);
    await flush();
    expect(supervisor.spawn).toHaveBeenCalledTimes(1);
    expect(w.activeJobIds()).toEqual(["job-a"]);
    expect(fireOnExit).not.toHaveBeenCalled();

    // Watched command exits → job fires through the run pipeline.
    runs[0].deferred.resolve({ exitCode: 0, reason: "exit" });
    await flush();
    expect(fireOnExit).toHaveBeenCalledTimes(1);
    expect(fireOnExit.mock.calls[0]?.[0].id).toBe("job-a");
    expect(fireOnExit.mock.calls[0]?.[1]).toMatchObject({
      exitCode: 0,
      reason: "exit",
      stdout: "",
      stderr: "",
    });
    // One-shot terminal state is persisted BEFORE firing (restart-safe).
    expect(persistCompletion).toHaveBeenCalledWith("job-a");
    expect(order).toEqual(["persist", "fire"]);
  });

  it("a fired job stays unarmed across a simulated restart (disabled in store → not re-run)", async () => {
    // persistCompletion disables the job; after a restart the reconcile sees a
    // disabled job and must NOT re-arm (which would re-run the command).
    const { supervisor, runs } = makeFakeSupervisor();
    const w = createCronExitWatchers({
      getProcessSupervisor: () => supervisor as never,
      persistCompletion: vi.fn(async () => {}),
      fireOnExit: vi.fn(async () => {}),
      logger: noopLogger,
    });
    w.reconcile([onExitJob("job-a")]);
    await flush();
    runs[0].deferred.resolve({ exitCode: 0, reason: "exit" });
    await flush();
    expect(supervisor.spawn).toHaveBeenCalledTimes(1);
    // Simulate restart: a fresh manager reconciling the now-disabled persisted job.
    const restarted = createCronExitWatchers({
      getProcessSupervisor: () => supervisor as never,
      persistCompletion: vi.fn(async () => {}),
      fireOnExit: vi.fn(async () => {}),
      logger: noopLogger,
    });
    restarted.reconcile([onExitJob("job-a", "sleep 1", false)]); // enabled=false after completion
    await flush();
    expect(supervisor.spawn).toHaveBeenCalledTimes(1); // no re-spawn → command not re-run
    expect(restarted.activeJobIds()).toEqual([]);
  });

  it("does NOT fire when persistCompletion fails (fail closed to avoid replay)", async () => {
    const { supervisor, runs } = makeFakeSupervisor();
    const fireOnExit = vi.fn(async () => {});
    const w = createCronExitWatchers({
      getProcessSupervisor: () => supervisor as never,
      persistCompletion: vi.fn(async () => {
        throw new Error("store write failed");
      }),
      fireOnExit,
      logger: noopLogger,
    });
    w.reconcile([onExitJob("job-a")]);
    await flush();
    runs[0].deferred.resolve({ exitCode: 0, reason: "exit" });
    await flush();
    expect(fireOnExit).not.toHaveBeenCalled();
    expect(w.activeJobIds()).toEqual([]);
    w.reconcile([onExitJob("job-a")]);
    await flush();
    expect(supervisor.spawn).toHaveBeenCalledTimes(2);
    expect(w.activeJobIds()).toEqual(["job-a"]);
  });

  it("releases the slot without firing when run.wait() rejects (fail closed on unknown outcome)", async () => {
    const { supervisor, runs } = makeFakeSupervisor();
    const persistCompletion = vi.fn(async () => {});
    const fireOnExit = vi.fn(async () => {});
    const w = createCronExitWatchers({
      getProcessSupervisor: () => supervisor as never,
      persistCompletion,
      fireOnExit,
      logger: noopLogger,
    });

    w.reconcile([onExitJob("job-a")]);
    await flush();
    expect(supervisor.spawn).toHaveBeenCalledTimes(1);
    expect(w.activeJobIds()).toEqual(["job-a"]);

    // wait() rejects (e.g. supervisor error) instead of resolving with an exit.
    runs[0].deferred.reject(new Error("supervisor wait blew up"));
    await flush();

    // Fail closed: no fire, no persisted terminal state on an unknown outcome.
    expect(fireOnExit).not.toHaveBeenCalled();
    expect(persistCompletion).not.toHaveBeenCalled();
    // Slot released so a subsequent reconcile can re-arm the job.
    expect(w.activeJobIds()).toEqual([]);
    w.reconcile([onExitJob("job-a")]);
    await flush();
    expect(supervisor.spawn).toHaveBeenCalledTimes(2);
    expect(w.activeJobIds()).toEqual(["job-a"]);
  });

  it("replaces the watcher when the watched command changes", async () => {
    const { supervisor, cancelledScopes } = makeFakeSupervisor();
    const w = createCronExitWatchers({
      getProcessSupervisor: () => supervisor as never,
      persistCompletion: vi.fn(async () => {}),
      fireOnExit: vi.fn(async () => {}),
      logger: noopLogger,
    });
    w.reconcile([onExitJob("job-a", "sleep 1")]);
    await flush();
    expect(supervisor.spawn).toHaveBeenCalledTimes(1);
    // Same job id, different command → cancel the stale watcher and re-arm.
    w.reconcile([onExitJob("job-a", "sleep 999")]);
    await flush();
    expect(cancelledScopes).toContain("cron-exit:job-a");
    expect(supervisor.spawn).toHaveBeenCalledTimes(2);
  });

  it("fires with the latest job snapshot when non-schedule fields change", async () => {
    const { supervisor, runs } = makeFakeSupervisor();
    const fireOnExit = vi.fn<FireOnExit>(async () => {});
    const w = createCronExitWatchers({
      getProcessSupervisor: () => supervisor as never,
      persistCompletion: vi.fn(async () => {}),
      fireOnExit,
      logger: noopLogger,
    });
    w.reconcile([onExitJob("job-a")]);
    await flush();

    w.reconcile([
      {
        ...onExitJob("job-a"),
        payload: { kind: "systemEvent", text: "updated" },
      } as CronJob,
    ]);
    runs[0].deferred.resolve({ exitCode: 0, reason: "exit" });
    await flush();

    expect(supervisor.spawn).toHaveBeenCalledTimes(1);
    expect(fireOnExit.mock.calls[0]?.[0]).toMatchObject({
      payload: { kind: "systemEvent", text: "updated" },
    });
  });

  it("cancels and kills an in-flight spawn when the job is removed mid-spawn", async () => {
    const fake = makeFakeSupervisor({ deferSpawn: true });
    const fireOnExit = vi.fn(async () => {});
    const w = createCronExitWatchers({
      getProcessSupervisor: () => fake.supervisor as never,
      persistCompletion: vi.fn(async () => {}),
      fireOnExit,
      logger: noopLogger,
    });
    w.reconcile([onExitJob("job-a")]);
    await flush(); // spawn is awaiting the gate (in flight, untracked child)
    w.reconcile([]); // remove the job while the spawn is in flight
    fake.releaseSpawn(); // spawn now resolves
    await flush();
    await flush();
    // The orphaned child is killed and the job never fires.
    expect(fake.runCancels.length).toBe(1);
    expect(fireOnExit).not.toHaveBeenCalled();
    expect(w.activeJobIds()).toEqual(["job-a"]);
    fake.runs[0].deferred.resolve({ exitCode: null, reason: "manual-cancel" });
    await vi.waitFor(() => expect(w.activeJobIds()).toEqual([]));
  });

  it("does not arm a watcher for time-based or disabled jobs", async () => {
    const { supervisor } = makeFakeSupervisor();
    const w = createCronExitWatchers({
      getProcessSupervisor: () => supervisor as never,
      persistCompletion: vi.fn(async () => {}),
      fireOnExit: vi.fn(async () => {}),
      logger: noopLogger,
    });
    const everyJob = {
      ...onExitJob("timer"),
      schedule: { kind: "every", everyMs: 1000 },
    } as unknown as CronJob;
    w.reconcile([everyJob, onExitJob("disabled", "true", false)]);
    await flush();
    expect(supervisor.spawn).not.toHaveBeenCalled();
    expect(w.activeJobIds()).toEqual([]);
  });

  it("is idempotent: re-reconciling the same job does not double-arm", async () => {
    const { supervisor } = makeFakeSupervisor();
    const w = createCronExitWatchers({
      getProcessSupervisor: () => supervisor as never,
      persistCompletion: vi.fn(async () => {}),
      fireOnExit: vi.fn(async () => {}),
      logger: noopLogger,
    });
    w.reconcile([onExitJob("job-a")]);
    await flush();
    w.reconcile([onExitJob("job-a")]);
    await flush();
    expect(supervisor.spawn).toHaveBeenCalledTimes(1);
  });

  it("keeps a cancelled watcher blocking until the supervised child settles", async () => {
    const { supervisor, cancelled, runs } = makeFakeSupervisor();
    const w = createCronExitWatchers({
      getProcessSupervisor: () => supervisor as never,
      persistCompletion: vi.fn(async () => {}),
      fireOnExit: vi.fn(async () => {}),
      logger: noopLogger,
    });
    w.reconcile([onExitJob("job-a")]);
    await flush();
    w.reconcile([]);
    expect(cancelled).toContain("cron-exit:job-a");
    expect(w.activeJobIds()).toEqual(["job-a"]);

    runs[0].deferred.resolve({ exitCode: null, reason: "manual-cancel" });
    await vi.waitFor(() => expect(w.activeJobIds()).toEqual([]));
  });

  it("does not fire a job whose watcher was cancelled before exit", async () => {
    const { supervisor, runs } = makeFakeSupervisor();
    const fireOnExit = vi.fn(async () => {});
    const w = createCronExitWatchers({
      getProcessSupervisor: () => supervisor as never,
      persistCompletion: vi.fn(async () => {}),
      fireOnExit,
      logger: noopLogger,
    });
    w.reconcile([onExitJob("job-a")]);
    await flush();
    w.reconcile([]); // cancel before the command exits
    runs[0].deferred.resolve({ exitCode: 0, reason: "manual-cancel" });
    await flush();
    expect(fireOnExit).not.toHaveBeenCalled();
  });

  it("retains a blocker and suppresses stale fire when removed during terminal persistence", async () => {
    const { supervisor, runs } = makeFakeSupervisor();
    let releasePersist = () => {};
    const persistCompletion = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releasePersist = resolve;
        }),
    );
    const fireOnExit = vi.fn(async () => {});
    const w = createCronExitWatchers({
      getProcessSupervisor: () => supervisor as never,
      persistCompletion,
      fireOnExit,
      logger: noopLogger,
    });
    w.reconcile([onExitJob("job-a")]);
    await flush();

    runs[0].deferred.resolve({ exitCode: 0, reason: "exit" });
    await vi.waitFor(() => expect(persistCompletion).toHaveBeenCalledOnce());
    w.reconcile([]);
    expect(w.activeJobIds()).toEqual(["job-a"]);

    releasePersist();
    await vi.waitFor(() => expect(w.activeJobIds()).toEqual([]));
    expect(fireOnExit).not.toHaveBeenCalled();
  });

  it("is one-shot: a fired job is not re-armed on a later reconcile", async () => {
    const { supervisor, runs } = makeFakeSupervisor();
    const w = createCronExitWatchers({
      getProcessSupervisor: () => supervisor as never,
      persistCompletion: vi.fn(async () => {}),
      fireOnExit: vi.fn(async () => {}),
      logger: noopLogger,
    });
    w.reconcile([onExitJob("job-a")]);
    await flush();
    runs[0].deferred.resolve({ exitCode: 0, reason: "exit" });
    await flush();
    w.reconcile([onExitJob("job-a")]);
    await flush();
    expect(supervisor.spawn).toHaveBeenCalledTimes(1);
  });
});

describe("resolveExitWatchShell", () => {
  it("uses cmd.exe on Windows so native gateways without bash can run on-exit", () => {
    const shell = resolveExitWatchShell("win32");
    expect(shell.command).toMatch(/cmd\.exe$/i);
    expect(shell.argsFor("echo hi")).toEqual(["/d", "/s", "/c", "echo hi"]);
  });

  it("uses bash -lc on POSIX (unchanged from prior behavior)", () => {
    expect(resolveExitWatchShell("linux").command).toBe("bash");
    expect(resolveExitWatchShell("linux").argsFor("echo hi")).toEqual(["-lc", "echo hi"]);
    expect(resolveExitWatchShell("darwin").command).toBe("bash");
  });
});
