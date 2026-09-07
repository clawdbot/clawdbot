import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as doctorMaintenance from "../commands/doctor-maintenance.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { SQLITE_READONLY_CHILD_ARG } from "../infra/sqlite-readonly-worker.js";
import * as coordinators from "../infra/state-database-coordinator.js";
import { DoctorStateMigrationRefusalError } from "../infra/state-migrations.messages.js";
import {
  assertNoOpenClawAgentDatabaseLeasesReadOnly,
  claimOpenClawAgentDatabaseLease,
} from "../state/openclaw-agent-db-lease.js";
import { recordOpenClawDatabaseQuarantine } from "../state/openclaw-quarantine-store.js";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorHealthFlow } from "./doctor-health.js";
import { mocks } from "./doctor-health.test-support.js";

const snapshotProcesses = vi.hoisted(() => ({
  execFile: vi.fn<typeof import("node:child_process").execFile>(),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  snapshotProcesses.execFile.mockImplementation(actual.execFile);
  Object.defineProperties(
    snapshotProcesses.execFile,
    Object.getOwnPropertyDescriptors(actual.execFile),
  );
  return { ...actual, execFile: snapshotProcesses.execFile };
});

const maintenance = vi.hoisted(() => ({ finish: vi.fn(), release: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

describe("Doctor refused-migration maintenance outcome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(doctorMaintenance, "beginDoctorMaintenance").mockResolvedValue(maintenance);
    mocks.config.mockReturnValue({});
    mocks.packageRoot.mockReturnValue(undefined);
  });

  it.each([true, false])(
    "releases maintenance after migration refusal=%s",
    async (migrationRefusal) => {
      const failure = migrationRefusal
        ? new DoctorStateMigrationRefusalError([])
        : new Error("service repair failed");
      mocks.runContributions.mockRejectedValueOnce(failure);
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      await expect(
        runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true }),
      ).rejects.toBe(failure);
      expect(maintenance.release).toHaveBeenCalledOnce();
      expect(maintenance.finish).not.toHaveBeenCalled();
      expect(mocks.outro).not.toHaveBeenCalled();
      if (migrationRefusal) {
        expect(runtime.error).not.toHaveBeenCalled();
      } else {
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("Check the reported service state"),
        );
      }
    },
  );
});

describe("Doctor maintenance admission", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(["gateway", "state", "agent"] as const)(
    "refuses the live %s owner before spawning a database snapshot",
    async (owner) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        mocks.config.mockReturnValue({});
        mocks.packageRoot.mockReturnValue(undefined);
        const database = openOpenClawStateDatabase({ env: state.env });
        if (owner === "agent") {
          claimOpenClawAgentDatabaseLease({
            agentId: "main",
            path: state.statePath("agents/main/agent/openclaw-agent.sqlite"),
            env: state.env,
          });
        }
        closeOpenClawStateDatabaseByPath(database.path);
        const before = fs.existsSync(state.configPath)
          ? fs.readFileSync(state.configPath, "utf8")
          : undefined;
        if (owner !== "agent") {
          vi.spyOn(
            coordinators,
            owner === "gateway"
              ? "acquireGatewayLifecycleCoordinator"
              : "acquireStateDatabaseCoordinator",
          ).mockImplementation(() => {
            throw new coordinators.StateDatabaseCoordinatorContentionError(
              owner === "gateway" ? "gateway-lifecycle" : "state-lifecycle",
            );
          });
        }
        await import("../commands/doctor-maintenance.js");
        snapshotProcesses.execFile.mockClear();
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        const started = performance.now();
        const failure = await runDoctorHealthFlow(runtime, {
          repair: true,
          nonInteractive: true,
        }).catch((error: unknown) => error);
        expect(
          snapshotProcesses.execFile.mock.calls.filter(
            (call) => Array.isArray(call[1]) && call[1].includes(SQLITE_READONLY_CHILD_ARG),
          ),
        ).toEqual([]);
        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).toMatch(/Stop.*service|stop.*process/);
        expect(performance.now() - started).toBeLessThan(1_000);
        expect(
          fs.existsSync(state.configPath) ? fs.readFileSync(state.configPath, "utf8") : undefined,
        ).toBe(before);
      });
    },
  );
});

describe("Doctor agent lease admission", () => {
  it("admits a restored primary database without opening or clearing its quarantine store", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.statePath("state/openclaw.sqlite");
      fs.mkdirSync(state.statePath("state"), { recursive: true });
      const db = openNodeSqliteDatabase(pathname);
      db.exec(
        "PRAGMA user_version=1; CREATE TABLE restored(value TEXT); INSERT INTO restored VALUES ('retained');",
      );
      db.close();
      expect(
        recordOpenClawDatabaseQuarantine({
          env: state.env,
          kind: "state",
          path: pathname,
          reason: "previous corrupt generation",
        }),
      ).toBe(true);
      const quarantine = state.statePath("state/openclaw-quarantine.sqlite");
      const before = [fs.readFileSync(pathname), fs.readFileSync(quarantine)];
      expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: state.env })).not.toThrow();
      expect([fs.readFileSync(pathname), fs.readFileSync(quarantine)]).toEqual(before);
    });
  });
});
