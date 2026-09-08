import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UPDATE_RUN_DRIVER_LIMIT } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createUpdateRunProgress } from "../cli/update-cli/update-command-run.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as pidAlive from "../shared/pid-alive.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { inspectUpdateRunAbandonment } from "./update-run-activity.js";
import { readUpdateRunDriver, type UpdateRunDriver } from "./update-run-driver.js";
import {
  adoptUpdateRun,
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  heartbeatUpdateRun,
  reconcileAbandonedUpdateRuns,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "./update-run-ledger.js";
import { ABANDONED_UPDATE_RUN_MS, UPDATE_RUN_HEARTBEAT_MS } from "./update-run-timeouts.js";
import { runStep } from "./update-runner-command.js";
import type { CommandRunner } from "./update-runner-types.js";

const tempDirs = createTempDirTracker();

function isolatedOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-update-abandonment-") } };
}

function currentDriver(): UpdateRunDriver {
  const driver = readUpdateRunDriver();
  if (!driver) {
    throw new Error("Test process identity is unavailable");
  }
  return driver;
}

function exitedDriver(): UpdateRunDriver {
  const driver = currentDriver();
  // The current PID belongs to a different generation than the recorded driver.
  return { ...driver, startIdentity: String(Number(driver.startIdentity) + 1) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

describe("abandoned update runs", () => {
  it("adopts without identity when process inspection is unavailable", () => {
    const options = isolatedOptions();
    const created = createUpdateRun({ trigger: "cli" }, options);
    vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(null);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const adopted = adoptUpdateRun(created.runId, options);
    adoptUpdateRun(created.runId, options);

    expect(adopted.origin.driver).toBeUndefined();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("identity recording is unavailable"),
    );
    vi.advanceTimersByTime(ABANDONED_UPDATE_RUN_MS + 10);
    expect(reconcileAbandonedUpdateRuns({}, options)).toEqual([]);
    expect(reconcileAbandonedUpdateRuns({ explicit: true }, options)).toMatchObject([
      { runId: created.runId, status: "failed", reason: "abandoned" },
    ]);
  });

  it("preserves a known parent and the unobservable adopter across later driver death", () => {
    const options = isolatedOptions();
    const parent = currentDriver();
    const created = createUpdateRun({ trigger: "cli", origin: { driver: parent } }, options);
    const inspection = vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(null);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    adoptUpdateRun(created.runId, options);
    for (let index = 0; index < 150; index++) {
      recordUpdateRunStep(
        created.runId,
        { step: `diagnostic:${index}`, status: "completed" },
        options,
      );
    }
    vi.advanceTimersByTime(ABANDONED_UPDATE_RUN_MS + 1_000);
    inspection.mockReturnValue(Number(parent.startIdentity));
    expect(reconcileAbandonedUpdateRuns({ explicit: true }, options)).toEqual([]);
    inspection.mockReturnValue(Number(parent.startIdentity) + 1);
    expect(reconcileAbandonedUpdateRuns({}, options)).toEqual([]);
    expect(reconcileAbandonedUpdateRuns({ explicit: true }, options)).toMatchObject([
      { runId: created.runId, status: "failed", reason: "abandoned" },
    ]);
  });

  it("keeps a command running after heartbeat errors and warns once across its steps", async () => {
    const options = isolatedOptions();
    const run = adoptUpdateRun(createUpdateRun({ trigger: "cli" }, options).runId, options);
    const progress = createUpdateRunProgress({ runId: run.runId, env: options.env }, {});
    progress.onHeartbeat = vi.fn(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const name of ["install", "build"]) {
      const command = createDeferredCore<Awaited<ReturnType<CommandRunner>>>();
      const aborted = vi.fn(() => command.reject(new Error("command aborted")));
      const pending = runStep({
        runCommand: (_argv, input) => {
          input.signal?.addEventListener("abort", aborted);
          return command.promise;
        },
        name,
        argv: ["pnpm", name],
        cwd: options.env.OPENCLAW_STATE_DIR,
        timeoutMs: ABANDONED_UPDATE_RUN_MS,
        progress,
        stepIndex: 0,
        totalSteps: 2,
      });
      const settled = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(UPDATE_RUN_HEARTBEAT_MS * 2);
      expect(aborted).not.toHaveBeenCalled();
      command.resolve({ stdout: "", stderr: "", code: 0 });
      expect(await settled).toMatchObject({ exitCode: 0 });
      expect(getUpdateRun(run.runId, options)?.steps).toContainEqual(
        expect.objectContaining({ step: name, status: "completed" }),
      );
    }
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("SQLITE_BUSY"));
  });

  it("classifies without writing, then finishes an aged staging run whose driver exited", () => {
    const options = isolatedOptions();
    const created = createUpdateRun(
      { trigger: "cli", origin: { driver: exitedDriver() } },
      options,
    );
    const run = recordUpdateRunPhase(created.runId, "staging", {}, options);
    vi.advanceTimersByTime(ABANDONED_UPDATE_RUN_MS + 10);

    expect(inspectUpdateRunAbandonment(run)).toBe("inactive-driver-dead");
    expect(getUpdateRun(run.runId, options)).toEqual(run);
    expect(reconcileAbandonedUpdateRuns({}, options)).toMatchObject([
      {
        runId: run.runId,
        status: "failed",
        phase: "finished",
        reason: "abandoned",
        finishedAtMs: Date.now(),
        steps: expect.arrayContaining([
          expect.objectContaining({
            step: "reconcile:abandoned",
            status: "failed",
            detail: "inactive-driver-dead",
          }),
        ]),
      },
    ]);
    expect(getUpdateRun(run.runId, options)?.reason).toBe("abandoned");
    expect(reconcileAbandonedUpdateRuns({}, options)).toEqual([]);
  });

  it("preserves a recent run even when its driver exited", () => {
    const options = isolatedOptions();
    const run = createUpdateRun({ trigger: "cli", origin: { driver: exitedDriver() } }, options);
    vi.advanceTimersByTime(ABANDONED_UPDATE_RUN_MS - 1);

    expect(inspectUpdateRunAbandonment(run, { explicit: true })).toBeUndefined();
    expect(reconcileAbandonedUpdateRuns({ explicit: true }, options)).toEqual([]);
    expect(getUpdateRun(run.runId, options)).toEqual(run);
  });

  it.each([false, true])("preserves an aged live staging driver with explicit=%s", (explicit) => {
    const options = isolatedOptions();
    const created = createUpdateRun(
      { trigger: "cli", origin: { driver: currentDriver() } },
      options,
    );
    const run = recordUpdateRunPhase(created.runId, "staging", {}, options);
    vi.advanceTimersByTime(ABANDONED_UPDATE_RUN_MS + 10);

    expect(inspectUpdateRunAbandonment(run, { explicit })).toBeUndefined();
    expect(reconcileAbandonedUpdateRuns({ explicit }, options)).toEqual([]);
    expect(getUpdateRun(run.runId, options)).toEqual(run);
  });

  it("preserves an aged driver whose host cannot be inspected, including explicit repair", () => {
    const options = isolatedOptions();
    const driver = { ...exitedDriver(), host: `${currentDriver().host}-other` };
    const run = createUpdateRun({ trigger: "cli", origin: { driver } }, options);
    vi.advanceTimersByTime(ABANDONED_UPDATE_RUN_MS + 1);

    expect(inspectUpdateRunAbandonment(run, { explicit: true })).toBeUndefined();
    expect(reconcileAbandonedUpdateRuns({ explicit: true }, options)).toEqual([]);
    expect(getUpdateRun(run.runId, options)).toEqual(run);
  });

  it.each(["requested", "staging"] as const)(
    "requires explicit recovery for an aged identityless %s run",
    (phase) => {
      const options = isolatedOptions();
      const created = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } }, options);
      const run =
        phase === "requested" ? created : recordUpdateRunPhase(created.runId, phase, {}, options);
      vi.advanceTimersByTime(ABANDONED_UPDATE_RUN_MS + 2);

      expect(inspectUpdateRunAbandonment(run)).toBeUndefined();
      expect(reconcileAbandonedUpdateRuns({}, options)).toEqual([]);
      expect(getUpdateRun(run.runId, options)).toEqual(run);
      expect(inspectUpdateRunAbandonment(run, { explicit: true })).toBe(
        "operator-reconciled-inactive-run",
      );
      expect(reconcileAbandonedUpdateRuns({ explicit: true }, options)).toMatchObject([
        { runId: run.runId, status: "failed", phase: "finished", reason: "abandoned" },
      ]);
    },
  );

  it.each(["requested", "staging"] as const)(
    "supersedes the single stale identityless %s run on explicit admission",
    (phase) => {
      const options = isolatedOptions();
      const old = createUpdateRun(
        { trigger: "control-ui", before: { version: "2026.9.2" } },
        options,
      );
      recordUpdateRunPhase(old.runId, phase, {}, options);
      vi.advanceTimersByTime(ABANDONED_UPDATE_RUN_MS + 10);

      const next = createUpdateRun(
        { trigger: "cli", origin: { driver: currentDriver() }, supersedeStaleIdentityless: true },
        options,
      );

      expect(next).toMatchObject({ status: "running", origin: { driver: currentDriver() } });
      expect(getUpdateRun(old.runId, options)).toMatchObject({
        status: "failed",
        phase: "finished",
        reason: "superseded",
        steps: expect.arrayContaining([
          expect.objectContaining({
            step: "reconcile:superseded",
            status: "failed",
            detail: "operator-started-update-supersedes-inactive-identityless-run",
          }),
        ]),
      });
    },
  );

  it.each([
    "recent",
    "live",
    "dead",
    "previous-live",
    "multiple",
    "implicit",
    "inherited",
    "campaign",
  ] as const)("does not supersede protected rows on %s admission", (kind) => {
    const options = isolatedOptions();
    const old = createUpdateRun(
      {
        trigger: "cli",
        origin:
          kind === "live"
            ? { driver: currentDriver() }
            : kind === "dead"
              ? { driver: exitedDriver() }
              : kind === "previous-live"
                ? { previousDrivers: [currentDriver()] }
                : {},
      },
      options,
    );
    if (kind !== "recent") {
      vi.advanceTimersByTime(ABANDONED_UPDATE_RUN_MS + 10);
    }
    if (kind === "multiple") {
      createUpdateRun({ trigger: "cli" }, options);
    }
    createUpdateRun(
      {
        trigger: kind === "campaign" ? "campaign" : "cli",
        runId: kind === "inherited" ? old.runId : undefined,
        supersedeStaleIdentityless: kind !== "implicit",
      },
      options,
    );
    expect(getUpdateRun(old.runId, options)).toEqual(old);
    if (kind === "recent") {
      expect(
        reconcileAbandonedUpdateRuns({ explicit: true, runIds: [old.runId] }, options),
      ).toEqual([]);
    }
  });

  it.each(["succeeded", "failed", "rolled-back", "skipped"] as const)(
    "preserves an already %s run",
    (status) => {
      const options = isolatedOptions();
      const created = createUpdateRun(
        { trigger: "cli", origin: { driver: exitedDriver() } },
        options,
      );
      const run = finishUpdateRun(created.runId, { status }, options);
      vi.advanceTimersByTime(ABANDONED_UPDATE_RUN_MS + 2);

      expect(inspectUpdateRunAbandonment(run, { explicit: true })).toBeUndefined();
      expect(reconcileAbandonedUpdateRuns({ explicit: true }, options)).toEqual([]);
      expect(getUpdateRun(run.runId, options)).toEqual(run);
    },
  );

  it("rechecks current activity when a previously stale run advanced", () => {
    const options = isolatedOptions();
    const run = createUpdateRun({ trigger: "cli", origin: { driver: exitedDriver() } }, options);
    vi.advanceTimersByTime(ABANDONED_UPDATE_RUN_MS + 1);
    expect(inspectUpdateRunAbandonment(run)).toBe("inactive-driver-dead");

    const advanced = recordUpdateRunStep(
      run.runId,
      { step: "build", status: "completed", endedAtMs: Date.now() },
      options,
    );
    expect(reconcileAbandonedUpdateRuns({ explicit: true, runIds: [run.runId] }, options)).toEqual(
      [],
    );
    expect(getUpdateRun(run.runId, options)).toEqual(advanced);
  });

  it("preserves the whole explicit recovery selection when one driver resumes", () => {
    const options = isolatedOptions();
    const first = createUpdateRun({ trigger: "cli" }, options);
    const second = createUpdateRun({ trigger: "cli" }, options);
    vi.advanceTimersByTime(ABANDONED_UPDATE_RUN_MS + 10);
    const resumed = recordUpdateRunStep(
      second.runId,
      { step: "build", status: "in_progress", startedAtMs: Date.now() },
      options,
    );

    expect(
      reconcileAbandonedUpdateRuns(
        { explicit: true, runIds: [first.runId, second.runId] },
        options,
      ),
    ).toEqual([]);
    expect(getUpdateRun(first.runId, options)).toEqual(first);
    expect(getUpdateRun(second.runId, options)).toEqual(resumed);
  });

  it("commits every eligible row in the explicit recovery selection", () => {
    const options = isolatedOptions();
    const runs = [
      createUpdateRun({ trigger: "cli" }, options),
      createUpdateRun({ trigger: "cli" }, options),
    ];
    vi.advanceTimersByTime(ABANDONED_UPDATE_RUN_MS + 10);
    const reconciled = reconcileAbandonedUpdateRuns(
      { explicit: true, runIds: runs.map((run) => run.runId), requireAllActive: true },
      options,
    );
    expect(reconciled.map((run) => run.runId).toSorted()).toEqual(
      runs.map((run) => run.runId).toSorted(),
    );
    for (const run of runs) {
      expect(getUpdateRun(run.runId, options)).toMatchObject({
        status: "failed",
        reason: "abandoned",
      });
    }
  });

  it("automatically reconciles a dead driver while preserving other active rows", () => {
    const options = isolatedOptions();
    const dead = createUpdateRun({ trigger: "cli", origin: { driver: exitedDriver() } }, options);
    const live = createUpdateRun({ trigger: "cli", origin: { driver: currentDriver() } }, options);
    const legacy = createUpdateRun({ trigger: "cli" }, options);
    vi.advanceTimersByTime(ABANDONED_UPDATE_RUN_MS + 10);

    expect(reconcileAbandonedUpdateRuns({}, options)).toMatchObject([
      { runId: dead.runId, status: "failed", reason: "abandoned" },
    ]);
    expect(getUpdateRun(live.runId, options)).toEqual(live);
    expect(getUpdateRun(legacy.runId, options)).toEqual(legacy);
  });

  it("preserves a captured recovery selection when another active run exists", () => {
    const options = isolatedOptions();
    const captured = createUpdateRun({ trigger: "cli" }, options);
    vi.advanceTimersByTime(ABANDONED_UPDATE_RUN_MS + 10);
    const admitted = createUpdateRun({ trigger: "cli" }, options);

    expect(
      reconcileAbandonedUpdateRuns(
        { explicit: true, runIds: [captured.runId], requireAllActive: true },
        options,
      ),
    ).toEqual([]);
    expect(getUpdateRun(captured.runId, options)).toEqual(captured);
    expect(getUpdateRun(admitted.runId, options)).toEqual(admitted);
  });

  it("adopts an exited driver and rejects its old heartbeat without refreshing activity", () => {
    const options = isolatedOptions();
    const oldDriver = exitedDriver();
    const created = createUpdateRun({ trigger: "cli", origin: { driver: oldDriver } }, options);
    const adopted = adoptUpdateRun(created.runId, options);
    expect(adopted.origin.driver).toEqual(currentDriver());
    vi.advanceTimersByTime(UPDATE_RUN_HEARTBEAT_MS);

    heartbeatUpdateRun(created.runId, oldDriver, options);
    expect(getUpdateRun(created.runId, options)).toEqual(adopted);
    expect(adoptUpdateRun(created.runId, options)).toEqual(adopted);
    heartbeatUpdateRun(created.runId, adopted.origin.driver, options);
    expect(getUpdateRun(created.runId, options)?.updatedAtMs).toBeGreaterThan(adopted.updatedAtMs);
  });

  it("rejects adoption after reconciliation instead of resuming a terminal run", () => {
    const options = isolatedOptions();
    const created = createUpdateRun(
      { trigger: "cli", origin: { driver: exitedDriver() } },
      options,
    );
    recordUpdateRunPhase(created.runId, "staging", {}, options);
    vi.advanceTimersByTime(ABANDONED_UPDATE_RUN_MS + 10);
    const [reconciled] = reconcileAbandonedUpdateRuns({}, options);
    expect(reconciled).toMatchObject({
      runId: created.runId,
      status: "failed",
      reason: "abandoned",
    });

    expect(() => adoptUpdateRun(created.runId, options)).toThrow();
    expect(getUpdateRun(created.runId, options)).toEqual(reconciled);
  });

  it("records the child while retaining and renewing its live controlling parent", () => {
    const options = isolatedOptions();
    const parentStart = getFileLockProcessStartTime(process.ppid);
    if (parentStart === null) {
      throw new Error("The test's controlling parent must have an observable start identity.");
    }
    const driver = { ...currentDriver(), pid: process.ppid, startIdentity: String(parentStart) };
    const created = createUpdateRun({ trigger: "cli", origin: { driver } }, options);
    const run = recordUpdateRunPhase(created.runId, "verifying", {}, options);
    vi.advanceTimersByTime(ABANDONED_UPDATE_RUN_MS + 10);

    const adopted = adoptUpdateRun(run.runId, options);
    expect(adopted.origin).toMatchObject({ driver: currentDriver(), previousDrivers: [driver] });
    vi.advanceTimersByTime(UPDATE_RUN_HEARTBEAT_MS);
    heartbeatUpdateRun(run.runId, driver, options);
    expect(getUpdateRun(run.runId, options)?.updatedAtMs).toBeGreaterThan(adopted.updatedAtMs);
    expect(reconcileAbandonedUpdateRuns({ explicit: true }, options)).toEqual([]);
  });

  it.each(["alive", "unknown", "dead"] as const)(
    "reconciles a dead current driver only when its previous driver is also dead (%s)",
    (liveness) => {
      const options = isolatedOptions();
      const previous =
        liveness === "alive"
          ? currentDriver()
          : liveness === "dead"
            ? exitedDriver()
            : { ...currentDriver(), host: "other-host.invalid" };
      const run = createUpdateRun(
        { trigger: "cli", origin: { driver: exitedDriver(), previousDrivers: [previous] } },
        options,
      );
      vi.advanceTimersByTime(ABANDONED_UPDATE_RUN_MS + 10);
      const reconciled = reconcileAbandonedUpdateRuns({ explicit: true }, options);
      expect(reconciled).toHaveLength(liveness === "dead" ? 1 : 0);
      expect(getUpdateRun(run.runId, options)?.status).toBe(
        liveness === "dead" ? "failed" : "running",
      );
    },
  );

  it("deduplicates retained drivers and removes only positively dead identities on adoption", () => {
    const options = isolatedOptions();
    const retained = { ...currentDriver(), host: "other-host.invalid" };
    const run = createUpdateRun(
      {
        trigger: "cli",
        origin: { driver: retained, previousDrivers: [retained, currentDriver(), exitedDriver()] },
      },
      options,
    );
    const adopted = adoptUpdateRun(run.runId, options);
    expect(adopted.origin).toMatchObject({ driver: currentDriver(), previousDrivers: [retained] });
    vi.advanceTimersByTime(100);
    expect(adoptUpdateRun(run.runId, options)).toEqual(adopted);
  });

  it("refuses adoption without evicting an unobservable driver at capacity", () => {
    const options = isolatedOptions();
    const drivers = Array.from({ length: UPDATE_RUN_DRIVER_LIMIT }, (_, index) => ({
      ...currentDriver(),
      host: `other-host-${index}.invalid`,
    }));
    const run = createUpdateRun(
      { trigger: "cli", origin: { driver: drivers[0], previousDrivers: drivers.slice(1) } },
      options,
    );
    expect(() => adoptUpdateRun(run.runId, options)).toThrow(
      "too many live or unobservable drivers",
    );
    expect(getUpdateRun(run.runId, options)).toEqual(run);
  });

  it("preserves exact current and previous identities while bounding and redacting large origin diagnostics", () => {
    const options = isolatedOptions();
    const drivers = Array.from({ length: UPDATE_RUN_DRIVER_LIMIT }, (_, index) => ({
      host: `${"x".repeat(254)}${index}`,
      pid: index + 1,
      startIdentity: "9".repeat(128),
    }));
    const diagnostic = "😀".repeat(512);
    const run = createUpdateRun(
      {
        trigger: "cli",
        origin: {
          driver: drivers[0],
          previousDrivers: drivers.slice(1),
          requester: { channel: diagnostic, accountId: diagnostic, senderId: diagnostic },
          sessionKey: diagnostic,
          deliveryContext: {
            channel: diagnostic,
            to: diagnostic,
            accountId: diagnostic,
            threadId: diagnostic,
          },
          campaignId: diagnostic,
          doctorHint: diagnostic,
          nextAction: diagnostic,
        },
      },
      { ...options, redactPaths: drivers.map((driver) => driver.host) },
    );
    expect(run.origin.driver).toEqual(drivers[0]);
    expect(run.origin.previousDrivers).toEqual(drivers.slice(1));
    expect(Buffer.byteLength(JSON.stringify(run.origin))).toBeLessThanOrEqual(16 * 1024);
    expect(run.origin.doctorHint?.length).toBeLessThan(diagnostic.length);
    expect(getUpdateRun(run.runId, options)).toEqual(run);
  });

  it.each([false, true])(
    "renews a slow step and stops heartbeats after failure=%s",
    async (fails) => {
      const options = isolatedOptions();
      const created = createUpdateRun({ trigger: "cli" }, options);
      const run = adoptUpdateRun(created.runId, options);
      const progress = createUpdateRunProgress({ runId: run.runId, env: options.env }, {});
      const command = createDeferredCore<Awaited<ReturnType<CommandRunner>>>();
      const timersBefore = vi.getTimerCount();
      const pending = runStep({
        runCommand: () => command.promise,
        name: "build",
        argv: ["pnpm", "build"],
        cwd: options.env.OPENCLAW_STATE_DIR,
        timeoutMs: ABANDONED_UPDATE_RUN_MS * 2,
        progress,
        stepIndex: 0,
        totalSteps: 1,
      });
      const settled = fails
        ? expect(pending).rejects.toThrow("build interrupted")
        : expect(pending).resolves.toMatchObject({ exitCode: 0 });
      await vi.advanceTimersByTimeAsync(ABANDONED_UPDATE_RUN_MS + UPDATE_RUN_HEARTBEAT_MS);

      const active = getUpdateRun(run.runId, options);
      expect(active?.updatedAtMs).toBeGreaterThan(run.updatedAtMs + ABANDONED_UPDATE_RUN_MS);
      expect(active?.steps).toContainEqual(
        expect.objectContaining({ step: "build", status: "in_progress" }),
      );
      expect(reconcileAbandonedUpdateRuns({ explicit: true }, options)).toEqual([]);

      if (fails) {
        command.reject(new Error("build interrupted"));
      } else {
        command.resolve({ stdout: "", stderr: "", code: 0 });
      }
      await settled;
      expect(vi.getTimerCount()).toBe(timersBefore);
      const finished = getUpdateRun(run.runId, options);
      await vi.advanceTimersByTimeAsync(UPDATE_RUN_HEARTBEAT_MS * 2);
      expect(getUpdateRun(run.runId, options)).toEqual(finished);
    },
  );
});
