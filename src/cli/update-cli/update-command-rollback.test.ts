import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";

const mocks = vi.hoisted(() => ({ stop: vi.fn(), restart: vi.fn(), reachable: vi.fn() }));
vi.mock("./update-command-service.js", () => ({
  maybeStopManagedServiceBeforeMutableUpdate: mocks.stop,
  maybeRestartService: mocks.restart,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate: async () => {},
  resolveUpdatedGatewayRestartPort: async () => 19101,
}));
vi.mock("../daemon-cli/restart-health-probe.js", () => ({
  confirmGatewayReachable: mocks.reachable,
}));
import { rollbackFailedUpdate } from "./update-command-rollback.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());
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
    vi.clearAllMocks();
    mocks.reachable.mockResolvedValue({ reachable: true });
    mocks.stop.mockResolvedValue({
      stopped: true,
      serviceUpdateVerdict: {
        kind: "owned",
        root: "/candidate",
        fingerprint: "fixture",
        refreshDefinition: true,
      },
    });
    mocks.restart.mockResolvedValue(true);
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
        config: {},
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
});
