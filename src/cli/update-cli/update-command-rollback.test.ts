import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createConfigIO } from "../../config/config.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import type { PreManagedServiceStop } from "./update-command-service.js";

const mocks = vi.hoisted(() => ({
  stop: vi.fn(),
  restart: vi.fn(),
  reachable: vi.fn(),
}));
vi.mock("./update-command-service-command.js", () => ({
  runUpdatedInstallGatewayCommand: async () => true,
}));
vi.mock("./update-command-service.js", () => ({
  maybeStopManagedServiceBeforeMutableUpdate: mocks.stop,
  maybeRestartService: mocks.restart,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate: async (
    stopped: PreManagedServiceStop | undefined,
    safe: boolean,
  ) => stopped?.windowsTaskAutoStartRecovery?.restore(safe),
  resolveUpdatedGatewayRestartPort: async () => 19101,
}));
vi.mock("../daemon-cli/restart-health-probe.js", () => ({
  confirmGatewayReachable: mocks.reachable,
}));
import { rollbackFailedUpdate } from "./update-command-rollback.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());
async function readPreviousConfig(env: NodeJS.ProcessEnv) {
  const snapshot = await createConfigIO({ env, pluginValidation: "skip" }).readConfigFileSnapshot();
  return snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig;
}
function setVersion(file: string, version: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA user_version = ${version}`);
  } finally {
    db.close();
  }
}

describe("verified package rollback", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.reachable.mockResolvedValue({ reachable: true });
    mocks.stop.mockResolvedValue({
      stopped: true,
      stoppedAtMs: 100,
      serviceUpdateVerdict: {
        kind: "owned",
        root: "/candidate",
        fingerprint: "fixture",
        refreshDefinition: true,
      },
    });
    mocks.restart.mockImplementation(async ({ onVerified }) => {
      onVerified?.(125);
      return true;
    });
  });
  it.each([
    { change: "none", previousVerified: true, restored: true, service: "stopped" },
    { change: "shared", previousVerified: true, restored: false, service: "stopped" },
    { change: "agent", previousVerified: true, restored: false, service: "stopped" },
    { change: "during-stop", previousVerified: true, restored: false, service: "stopped" },
    { change: "none", previousVerified: false, restored: false, service: "stopped" },
    { change: "none", previousVerified: true, restored: false, service: "absent" },
    { change: "none", previousVerified: true, restored: false, service: "no-restart" },
  ])(
    "$change schema change; previous verified=$previousVerified; service=$service",
    async ({ change, previousVerified, restored, service }) => {
      const stateDir = dirs.make("update-schema-rollback-");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const config = await readPreviousConfig({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
      const shared = path.join(stateDir, "state/openclaw.sqlite");
      const agent = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
      setVersion(shared, 7);
      setVersion(agent, 3);
      const schemaVersions = await readUpdateStateSchemaVersions({ stateDir, config: {} });
      if (change === "shared") {
        setVersion(shared, 8);
      }
      if (change === "agent") {
        setVersion(agent, 4);
      }
      if (change === "during-stop") {
        mocks.stop.mockImplementationOnce(async () => {
          setVersion(agent, 4);
          return { stopped: true };
        });
      }
      const result: UpdateRunResult = {
        status: "error",
        reason: "version-mismatch",
        mode: "npm",
        root: "/candidate",
        before: { version: "2026.9.1" },
        after: { version: "2026.9.3" },
        steps: [],
        durationMs: 10,
      };
      const rollback = vi.fn(async () => ({
        name: "rollback",
        command: "restore",
        cwd: "/previous",
        exitCode: 0,
        durationMs: 1,
      }));
      const outcome = await rollbackFailedUpdate({
        result,
        previousRoot: "/previous",
        nodeRunner: "/candidate/node",
        schemaVersions,
        previousVerified,
        packageTransaction: { backupRoot: "/backup", rollback, complete: vi.fn() },
        config,
        opts: { json: true, restart: service !== "no-restart" },
        preManagedServiceStop:
          service === "absent"
            ? undefined
            : {
                stopped: service === "stopped",
                inspected: true,
                runtimeInspected: true,
                running: true,
                serviceEnv: { OPENCLAW_STATE_DIR: stateDir },
                serviceNodeRunner: "/previous/node",
                serviceUpdateVerdict: {
                  kind: "owned",
                  root: "/previous",
                  fingerprint: "fixture",
                  refreshDefinition: true,
                },
              },
        timeoutMs: 1_000,
      });
      expect(outcome.rolledBack).toBe(restored);
      expect(rollback).toHaveBeenCalledTimes(change === "none" ? 1 : 0);
      expect(mocks.restart).toHaveBeenCalledTimes(restored ? 1 : 0);
      if (service !== "stopped") {
        expect(mocks.stop).not.toHaveBeenCalled();
        expect(mocks.reachable).not.toHaveBeenCalled();
        expect(outcome.result).toMatchObject({
          root: "/previous",
          after: result.before,
          reason: result.reason,
          recovery: { serviceRestartSafe: false, packageRollbackVerified: true },
        });
        return;
      }
      if (restored) {
        expect(outcome).toMatchObject({ verifiedAtMs: 125, downtimeMs: 25 });
        expect(mocks.restart).toHaveBeenCalledWith(
          expect.objectContaining({ nodeRunner: "/previous/node" }),
        );
        expect(outcome.result).toMatchObject({
          root: "/previous",
          after: result.before,
          reason: "version-mismatch",
        });
        expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(
          rollback.mock.invocationCallOrder[0]!,
        );
        expect(rollback.mock.invocationCallOrder[0]).toBeLessThan(
          mocks.restart.mock.invocationCallOrder[0]!,
        );
      } else {
        expect(outcome.result.reason).toBe(
          previousVerified ? "state-migrated-no-rollback" : "previous-version-unverified",
        );
        if (!previousVerified) {
          expect(outcome.result).toMatchObject({ root: "/previous", after: result.before });
        }
      }
    },
  );

  it("leaves a failed rollback's task recovery with finalization", async () => {
    const complete = vi.fn(async () => {});
    const stopped = {
      stopped: true,
      windowsTaskAutoStartRecovery: {
        beginMutation: () => {},
        restore: vi.fn(async () => {}),
        complete,
        interrupted: () => false,
      },
    };
    mocks.stop.mockResolvedValueOnce(stopped);
    mocks.reachable.mockResolvedValueOnce({ reachable: false });
    const outcome = await rollbackFailedUpdate({
      result: {
        status: "error",
        mode: "npm",
        reason: "readyz-unhealthy",
        root: "/candidate",
        steps: [],
        durationMs: 1,
      },
      previousRoot: "/previous",
      rollbackBlockedReason: "state-migrated-no-rollback",
      config: {},
      opts: { json: true },
      timeoutMs: 1_000,
      preManagedServiceStop: {
        stopped: true,
        inspected: true,
        runtimeInspected: true,
        running: true,
        serviceEnv: { OPENCLAW_STATE_DIR: dirs.make("rollback-finalization-") },
      },
    });
    expect(outcome).toMatchObject({ rolledBack: false, stoppedForRollback: stopped });
    expect(complete).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  it.each(["source-failed", "restart-unhealthy", "restart-threw"] as const)(
    "retains active installation identity after %s",
    async (failure) => {
      const stateDir = dirs.make("rollback-source-failed-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const config = await readPreviousConfig(env);
      const schemaVersions = await readUpdateStateSchemaVersions({ stateDir, config: {}, env });
      const result: UpdateRunResult = {
        status: "error",
        mode: "npm",
        root: "/candidate",
        reason: "readyz-unhealthy",
        steps: [],
        durationMs: 1,
        before: { version: "2026.9.1" },
        after: { version: "2026.9.3" },
      };
      if (failure === "restart-threw") {
        mocks.restart.mockRejectedValueOnce(new Error("Service restart transport failed"));
      } else {
        mocks.restart.mockResolvedValueOnce(false);
      }
      const outcome = await rollbackFailedUpdate({
        result,
        previousRoot: "/previous",
        config,
        opts: { json: true },
        timeoutMs: 1_000,
        schemaVersions,
        previousVerified: true,
        preManagedServiceStop: {
          stopped: true,
          inspected: true,
          runtimeInspected: true,
          running: true,
          serviceEnv: env,
        },
        packageTransaction: {
          backupRoot: "/backup",
          complete: vi.fn(async () => {}),
          rollback: vi.fn(async () => ({
            name: "rollback",
            command: "restore",
            cwd: "/previous",
            exitCode: failure === "source-failed" ? 1 : 0,
            durationMs: 1,
          })),
        },
      });
      expect(outcome.result).toMatchObject({
        root: failure === "source-failed" ? "/candidate" : "/previous",
        after: failure === "source-failed" ? result.after : result.before,
        reason: failure === "source-failed" ? "source-rollback-failed" : result.reason,
        steps: [
          expect.objectContaining({
            name: "rollback",
            exitCode: failure === "source-failed" ? 1 : 0,
          }),
        ],
        ...(failure === "source-failed"
          ? {}
          : {
              recovery: { serviceRestartSafe: true, packageRollbackVerified: true },
            }),
      });
      expect(outcome.rolledBack).toBe(false);
      expect(mocks.restart).toHaveBeenCalledTimes(failure === "source-failed" ? 0 : 1);
    },
  );
});
