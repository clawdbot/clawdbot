// Install fixture mocks before importing the real maintenance owners.
import "./doctor-health.test-support.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import { runCommandWithRuntime } from "../cli/cli-utils.js";
import {
  maybeStopManagedServiceBeforeMutableUpdate,
  resolvePreparedGatewayUpdatePolicy,
} from "../cli/update-cli/update-command-service-maintenance.js";
import { collectSecurityWarnings } from "../commands/doctor-security.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayServiceReadOptions } from "../daemon/service-types.js";
import { readSystemdServiceExecStart } from "../daemon/systemd-service-files.js";
import { ExecApprovalsMigrationRequiredError } from "../infra/exec-approvals-migration-gate.js";
import {
  readExecApprovalsConfigRow,
  serializeExecApprovals,
  writeExecApprovalsConfigRow,
} from "../infra/exec-approvals-sqlite.js";
import { loadExecApprovalsReadOnly } from "../infra/exec-approvals-store.js";
import {
  resolveStateDatabaseCoordinatorPath,
  resolveStateLifecycleRuntimeDirectory,
} from "../infra/state-database-coordinator.js";
import {
  detectLegacyExecApprovals,
  migrateLegacyExecApprovals,
} from "../infra/state-migrations.exec-approvals.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import {
  detectLegacyWorkspaceState,
  migrateLegacyWorkspaceState,
} from "../infra/state-migrations.workspace-setup.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import {
  assertNoOpenClawAgentDatabaseLeases,
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const { mocks } = await import("./doctor-health.test-support.js");

describe("runDoctorHealthFlow maintenance", () => {
  it.each(
    [
      "inspection-failed",
      "user-bus-unavailable",
      "runtime-only",
      "owned-unknown",
      "foreign-running",
      "foreign-unknown",
      "foreign-stopped",
      "foreign-stopped-loaded",
      "foreign-stopped-loaded-disabled",
      "foreign-stopped-loaded-unknown",
      "foreign-respawning",
      "unresolved-running",
      "unresolved-unknown",
      "unresolved-stopped",
      "unresolved-stopped-loaded",
      "unresolved-respawning",
      "absent",
      "absent-unknown",
      "absent-busy-port",
      "absent-unknown-port",
      "windows-ready",
      "windows-disabled",
      "windows-queued",
      "windows-running",
      "windows-startup-stopped",
      "windows-startup-unknown",
    ].flatMap((kind) => [
      { kind, updateParent: false },
      { kind, updateParent: true },
    ]),
  )(
    "admits offline state repair only after safe service inspection: $kind (update=$updateParent)",
    async ({ kind, updateParent }) => {
      if (updateParent) {
        for (const [key, value] of Object.entries(
          buildUpdateDoctorEnv({
            allowGatewayServiceRepair: true,
            allowGatewayActivation: false,
          }),
        )) {
          vi.stubEnv(key, value);
        }
      }
      if (kind === "absent-busy-port" || kind === "absent-unknown-port") {
        mocks.probePortUsage.mockResolvedValue(kind === "absent-busy-port" ? "busy" : "unknown");
      }
      const windows = kind.startsWith("windows");
      mocks.emulateNativeInstall = kind !== "runtime-only";
      mocks.servicePlatform = windows ? "win32" : undefined;
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg: OpenClawConfig = {
          agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
        };
        await state.writeConfig(cfg);
        fs.mkdirSync(state.workspaceDir, { recursive: true });
        const sourcePath = path.join(state.workspaceDir, "openclaw-workspace-state.json");
        const completedAt = "2026-07-15T00:00:00.000Z";
        fs.writeFileSync(sourcePath, JSON.stringify({ version: 1, setupCompletedAt: completedAt }));
        const sourceBefore = fs.readFileSync(sourcePath);
        const configBefore = fs.readFileSync(state.configPath);
        const unitPath = path.join(
          state.home,
          ".config",
          "systemd",
          "user",
          "openclaw-gateway.service",
        );
        const unitContent =
          "[Service]\nExecStart=/usr/bin/openclaw gateway run\nEnvironment=OPENCLAW_GATEWAY_TOKEN=environment-secret-canary\n";
        if (kind === "user-bus-unavailable") {
          fs.mkdirSync(path.dirname(unitPath), { recursive: true });
          fs.writeFileSync(unitPath, unitContent);
          mocks.busctl.mockResolvedValue({
            code: 1,
            termination: "exit",
            stdout: "stdout-secret-canary",
            stderr:
              "Failed to connect to user scope bus via local transport: No such file or directory\nstderr-secret-canary",
          });
        }
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        const coordinatorPath = resolveStateDatabaseCoordinatorPath({
          databasePath,
          runtimeDirectory: resolveStateLifecycleRuntimeDirectory(),
          uid: process.getuid?.(),
        });
        expect(fs.existsSync(databasePath)).toBe(false);
        expect(fs.existsSync(coordinatorPath)).toBe(false);

        const foreign = kind.startsWith("foreign") || windows;
        const foreignRoot = state.path("foreign-install");
        if (foreign) {
          fs.mkdirSync(foreignRoot);
          fs.writeFileSync(path.join(foreignRoot, "package.json"), '{"name":"openclaw"}');
        }
        const entrypoint = kind.startsWith("unresolved")
          ? "operator-wrapper"
          : path.join(foreign ? foreignRoot : process.cwd(), "openclaw.mjs");
        const stop = vi.fn();
        const restart = vi.fn();
        mocks.packageRoot.mockReturnValue(process.cwd());
        mocks.config.mockClear().mockReturnValue(cfg);
        mocks.service.mockReturnValue({
          readCommand: async (env: NodeJS.ProcessEnv, opts?: GatewayServiceReadOptions) => {
            if (kind === "inspection-failed") {
              throw new Error("synthetic manager inspection failure");
            }
            if (kind === "user-bus-unavailable") {
              return await readSystemdServiceExecStart(env, opts);
            }
            return kind.startsWith("absent")
              ? null
              : {
                  programArguments: [process.execPath, entrypoint, "gateway"],
                  environment: {
                    OPENCLAW_STATE_DIR: foreign ? state.path("foreign-state") : state.stateDir,
                    OPENCLAW_CONFIG_PATH: foreign ? state.path("foreign.json") : state.configPath,
                  },
                };
          },
          readRuntime: async () => ({
            status:
              (kind.endsWith("unknown") && !kind.endsWith("loaded-unknown") && !windows) ||
              (kind.endsWith("respawning") && process.platform === "linux")
                ? "unknown"
                : kind.endsWith("running") && !windows
                  ? "running"
                  : "stopped",
            ...(kind.startsWith("absent") ? { missingUnit: true } : {}),
          }),
          isLoaded: async () => {
            if (kind === "absent-unknown") {
              throw new Error("synthetic manager unavailable");
            }
            return (
              windows ||
              kind.includes("stopped-loaded") ||
              kind.endsWith("running") ||
              kind.endsWith("loaded") ||
              kind.endsWith("respawning")
            );
          },
          isEnabled: async () => {
            if (kind.endsWith("loaded-unknown")) {
              throw new Error("synthetic enabled-state inspection failure");
            }
            return !kind.endsWith("loaded-disabled");
          },
          stop,
          restart,
        });
        mocks.taskDefinitelyStopped.mockReturnValue(
          windows
            ? kind === "windows-ready" || kind === "windows-disabled"
            : !kind.endsWith("respawning"),
        );
        if (kind === "windows-startup-stopped") {
          mocks.startupFallbackRuntime.mockResolvedValue({ status: "stopped" });
        } else if (kind === "windows-startup-unknown") {
          mocks.startupFallbackRuntime.mockRejectedValue(
            new Error("synthetic task inspection failure"),
          );
        }
        mocks.runContributions.mockImplementation(async (ctx) => {
          const result = await migrateLegacyWorkspaceState({
            stateDir: state.stateDir,
            env: state.env,
            detected: detectLegacyWorkspaceState({
              cfg: ctx.cfg,
              stateDir: state.stateDir,
              env: state.env,
              homedir: () => state.home,
              doctorOnlyStateMigrations: true,
            }),
          });
          expect(result.warnings).toEqual([]);
        });
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        const run = runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
        if (
          kind === "runtime-only" ||
          kind.endsWith("stopped") ||
          (kind.includes("stopped-loaded") && process.platform !== "darwin") ||
          kind === "absent" ||
          kind === "windows-ready" ||
          kind === "windows-disabled" ||
          kind.endsWith("loaded-disabled")
        ) {
          await run;
          expect(readWorkspaceStateSnapshot(state.workspaceDir).setup.setupCompletedAt).toBe(
            completedAt,
          );
          expect(fs.existsSync(sourcePath)).toBe(false);
          expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
          if (kind !== "absent" && kind !== "runtime-only") {
            expect(runtime.log).toHaveBeenCalledWith(
              expect.stringContaining("stopped Gateway service was left unchanged"),
            );
          }
        } else {
          await expect(run).rejects.toThrow("Doctor could not enter maintenance");
          await expect(run).rejects.toThrow("gateway status --deep");
          await expect(run).rejects.toThrow("openclaw doctor --fix");
          await expect(run).rejects.not.toThrow(/--no-restart|before the update/);
          expect(mocks.config).not.toHaveBeenCalled();
          expect(mocks.runContributions).not.toHaveBeenCalled();
          expect(fs.readFileSync(sourcePath)).toEqual(sourceBefore);
          expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
          expect(fs.existsSync(databasePath)).toBe(false);
          expect(fs.existsSync(coordinatorPath)).toBe(false);
          expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
        }
        if (kind === "absent" || kind === "absent-busy-port" || kind === "absent-unknown-port") {
          expect(mocks.probePortUsage).toHaveBeenCalledOnce();
        }
        if (windows) {
          expect(mocks.taskDefinitelyStopped).toHaveBeenCalled();
          if (kind.startsWith("windows-startup")) {
            expect(mocks.startupFallbackRuntime).toHaveBeenCalled();
          }
        }
        if (kind === "runtime-only") {
          expect(mocks.service).not.toHaveBeenCalled();
        }
        expect(stop).not.toHaveBeenCalled();
        expect(restart).not.toHaveBeenCalled();
        if (kind === "user-bus-unavailable") {
          await runCommandWithRuntime(runtime, () => run);
          expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
          expect(mocks.busctl).toHaveBeenCalledOnce();
          expect(fs.readFileSync(unitPath, "utf8")).toBe(unitContent);
          const output = runtime.error.mock.calls.flat().join("\n");
          expect(output).not.toContain("secret-canary");
          expect(output).toMatch(/user.*D-Bus/i);
        }
      });
    },
  );

  it.each([
    "ready",
    "clean-repair",
    "clean-inspect",
    "clean-force-repair",
    "clean-force-inspect",
    "update-no-restart",
    "update-no-restart-stopped",
    "update-parent-stopped",
    "update-legacy",
    "repair-failed",
    "store-close-failed",
    "config-refused",
    "workspace-cleanup-failed",
    "approvals-malformed",
    "approvals-conflicting",
    "approvals-migrated",
    "restart-unhealthy",
    "ancestor-blocked",
  ] as const)(
    "coordinates the matching managed writer through multi-agent repair: %s",
    async (outcome) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const clean = outcome.startsWith("clean-") || outcome.startsWith("update-");
        const inspectionOnly = outcome === "clean-inspect" || outcome === "clean-force-inspect";
        const force = outcome.startsWith("clean-force-");
        const cfg: OpenClawConfig = {
          agents: {
            ownership: "explicit",
            entries: {
              main: { workspace: state.workspaceDir },
              research: { workspace: state.path("research") },
            },
          },
        };
        await state.writeConfig(
          clean
            ? cfg
            : {
                agents: {
                  list: [
                    { id: "main", workspace: state.workspaceDir },
                    { id: "research", workspace: state.path("research") },
                  ],
                },
              },
        );
        mocks.config.mockReturnValue(cfg);
        const configBefore = fs.readFileSync(state.configPath);
        const approvalsCase = outcome.startsWith("approvals-");
        const approvalsBlocked = approvalsCase && outcome !== "approvals-migrated";
        const approvalsPath = state.statePath("exec-approvals.json");
        const canonicalApprovals = {
          version: 1 as const,
          defaults: { security: "deny" as const },
          agents: {},
        };
        const approvalsBefore =
          outcome === "approvals-malformed"
            ? '{"version":1,"agents":'
            : serializeExecApprovals({ version: 1, defaults: { security: "full" }, agents: {} });
        if (approvalsCase) {
          fs.writeFileSync(approvalsPath, approvalsBefore);
          if (outcome === "approvals-conflicting") {
            writeExecApprovalsConfigRow({
              db: openOpenClawStateDatabase({ env: state.env }).db,
              file: canonicalApprovals,
            });
          }
        }
        if (outcome === "workspace-cleanup-failed") {
          fs.mkdirSync(state.workspaceDir, { recursive: true });
          fs.writeFileSync(
            path.join(state.workspaceDir, "openclaw-workspace-state.json"),
            JSON.stringify({ version: 1, setupCompletedAt: "2026-07-15T00:00:00.000Z" }),
          );
        }
        const initial = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        const secondary = openOpenClawAgentDatabase({ agentId: "research", env: state.env });
        if (!clean) {
          secondary.db.exec(
            "DROP TABLE session_participants; PRAGMA user_version = 17; UPDATE schema_meta SET schema_version = 17;",
          );
          initial.db.exec(
            "DROP TABLE session_participants; PRAGMA user_version = 17; UPDATE schema_meta SET schema_version = 17;",
          );
        }
        closeOpenClawAgentDatabasesForTest();
        const leaseId = claimOpenClawAgentDatabaseLease({
          agentId: "main",
          path: initial.path,
          env: state.env,
        });
        const agentBefore = fs.readFileSync(initial.path);
        const events: string[] = [];
        let running = outcome !== "update-no-restart-stopped";
        const packageRoot = process.cwd();
        mocks.packageRoot.mockReturnValue(packageRoot);
        const command = {
          programArguments: [process.execPath, path.join(packageRoot, "openclaw.mjs"), "gateway"],
          environment: {
            OPENCLAW_STATE_DIR: state.stateDir,
            OPENCLAW_CONFIG_PATH: state.configPath,
          },
        };
        const stop = vi.fn(async () => {
          events.push("stop");
          running = false;
          releaseOpenClawAgentDatabaseLease(leaseId, { env: state.env });
        });
        const restart = vi.fn(async () => {
          events.push("restart");
          if (outcome === "ready") {
            expect(() =>
              assertNoOpenClawAgentDatabaseLeases("main", { env: state.env }),
            ).not.toThrow();
            expect(() =>
              assertNoOpenClawAgentDatabaseLeases("research", { env: state.env }),
            ).not.toThrow();
          }
          const reopened = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
          expect(reopened.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
            OPENCLAW_AGENT_SCHEMA_VERSION,
          );
          const research = openOpenClawAgentDatabase({ agentId: "research", env: state.env });
          expect(research.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
            OPENCLAW_AGENT_SCHEMA_VERSION,
          );
          running = true;
          return { outcome: "completed" as const };
        });
        mocks.service.mockReturnValue({
          readCommand: async () => command,
          readRuntime: async () => ({
            status: running ? "running" : "stopped",
            ...(outcome === "ancestor-blocked" ? { pid: process.pid } : {}),
          }),
          readLoadState: async () => ({ status: running ? "loaded" : "not-loaded" }),
          isLoaded: async () => running,
          isEnabled: async () => running,
          stop,
          restart,
        });
        mocks.runContributions.mockImplementation(async (ctx) => {
          events.push("repair");
          expect(ctx.gatewayMaintenanceActive).toBe(!inspectionOnly);
          if (clean) {
            return;
          }
          if (outcome === "repair-failed") {
            throw new Error("synthetic migration failure");
          }
          if (outcome === "config-refused") {
            ctx.configWriteRefusal = "validation";
            return;
          }
          const result = await migrateLegacyMediaPersistence();
          expect(result.warnings).toEqual([]);
          if (approvalsCase) {
            const approvals = await migrateLegacyExecApprovals({
              stateDir: state.stateDir,
              env: state.env,
              detected: detectLegacyExecApprovals({
                stateDir: state.stateDir,
                doctorOnlyStateMigrations: true,
              }),
            });
            expect(approvals.warnings.length > 0).toBe(approvalsBlocked);
            await collectSecurityWarnings(ctx.cfg, state.env);
          }
          if (outcome === "ready" || outcome === "store-close-failed") {
            // Later diagnostics reopen runtime handles after the migration closes its own.
            const reopened = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
            openOpenClawAgentDatabase({ agentId: "research", env: state.env });
            if (outcome === "store-close-failed") {
              vi.spyOn(reopened.db, "close").mockImplementationOnce(() => {
                throw new Error("synthetic database close failure");
              });
            }
          }
          if (outcome === "workspace-cleanup-failed") {
            const migration = await migrateLegacyWorkspaceState({
              stateDir: state.stateDir,
              env: state.env,
              detected: detectLegacyWorkspaceState({
                cfg: ctx.cfg,
                stateDir: state.stateDir,
                env: state.env,
                homedir: () => state.home,
                doctorOnlyStateMigrations: true,
              }),
              removeSource: () => {
                throw new Error("simulated unlink failure");
              },
            });
            expect(migration.warnings.join("\n")).toContain("legacy cleanup failed");
            expect(readWorkspaceStateSnapshot(state.workspaceDir).setup.setupCompletedAt).toBe(
              "2026-07-15T00:00:00.000Z",
            );
          }
        });
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        const expectCoordinatorReleased = () => {
          const coordinatorPath = resolveStateDatabaseCoordinatorPath({
            databasePath: resolveOpenClawStateSqlitePath(state.env),
            runtimeDirectory: resolveStateLifecycleRuntimeDirectory(),
            uid: process.getuid?.(),
          });
          const peer = spawnSync(process.execPath, [
            "-e",
            "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN EXCLUSIVE');db.close();",
            coordinatorPath,
          ]);
          expect(peer.status).toBe(0);
        };
        if (outcome === "config-refused") {
          runtime.exit.mockImplementation(expectCoordinatorReleased);
        }
        try {
          const modernUpdate = outcome.startsWith("update-") && outcome !== "update-legacy";
          if (modernUpdate) {
            if (!running) {
              releaseOpenClawAgentDatabaseLease(leaseId, { env: state.env });
            }
            const parentRestarts = outcome === "update-parent-stopped";
            const prepared = await maybeStopManagedServiceBeforeMutableUpdate({
              updateInstallKind: "package",
              root: packageRoot,
              shouldRestart: parentRestarts,
              jsonMode: true,
            });
            expect(prepared.stopped).toBe(parentRestarts);
            expect(running).toBe(outcome === "update-no-restart");
            expect(events).toEqual(parentRestarts ? ["stop"] : []);
            events.length = 0;
            stop.mockClear();
            const policy = resolvePreparedGatewayUpdatePolicy(prepared, parentRestarts);
            expect(policy).toEqual({
              allowGatewayServiceRepair: true,
              allowGatewayActivation: parentRestarts,
            });
            for (const [key, value] of Object.entries(buildUpdateDoctorEnv(policy))) {
              vi.stubEnv(key, value);
            }
          } else if (outcome === "update-legacy") {
            vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
          }
          mocks.restartedHealthy = outcome !== "restart-unhealthy";
          const run = runDoctorHealthFlow(runtime, {
            ...(inspectionOnly ? {} : { repair: true }),
            force,
            nonInteractive: true,
          });
          if (outcome === "update-no-restart") {
            await expect(run).rejects.toThrow("update parent");
            expect(events).toEqual([]);
            expect(stop).not.toHaveBeenCalled();
            expect(restart).not.toHaveBeenCalled();
            expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
            expect(fs.readFileSync(initial.path)).toEqual(agentBefore);
            return;
          }
          if (outcome === "ancestor-blocked") {
            await expect(run).rejects.toThrow("openclaw doctor --fix");
            await expect(run).rejects.toThrow("from a shell outside the gateway service");
            await expect(run).rejects.not.toThrow("openclaw update");
            expect(events).toEqual([]);
            expect(stop).not.toHaveBeenCalled();
            expect(restart).not.toHaveBeenCalled();
            expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
            return;
          }
          if (outcome === "repair-failed") {
            await expect(run).rejects.toThrow("synthetic migration failure");
          } else if (outcome === "store-close-failed") {
            await expect(run).rejects.toThrow("synthetic database close failure");
            expectCoordinatorReleased();
          } else if (outcome === "workspace-cleanup-failed") {
            await expect(run).rejects.toThrow(/workspace.*requires migration/);
          } else if (approvalsBlocked) {
            await expect(run).rejects.toThrow(ExecApprovalsMigrationRequiredError);
            expectCoordinatorReleased();
          } else if (outcome === "restart-unhealthy") {
            await expect(run).rejects.toThrow("managed Gateway did not become ready");
          } else {
            await run;
          }
          if (modernUpdate) {
            expect(events.filter((event) => event !== "repair")).toEqual([]);
            expect(stop).not.toHaveBeenCalled();
            expect(restart).not.toHaveBeenCalled();
            expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
            expect(fs.readFileSync(initial.path)).toEqual(agentBefore);
            return;
          }
          const shouldRestart =
            outcome === "ready" ||
            outcome === "restart-unhealthy" ||
            outcome === "clean-repair" ||
            outcome === "clean-force-repair" ||
            outcome === "approvals-migrated" ||
            outcome === "update-legacy";
          expect(events).toEqual(
            inspectionOnly
              ? ["repair"]
              : shouldRestart
                ? ["stop", "repair", "restart"]
                : ["stop", "repair"],
          );
          expect(stop).toHaveBeenCalledTimes(inspectionOnly ? 0 : 1);
          expect(restart).toHaveBeenCalledTimes(shouldRestart ? 1 : 0);
          if (shouldRestart) {
            expect(restart).toHaveBeenCalledWith(
              expect.objectContaining({ preserveDefinition: true }),
            );
          }
          if (clean) {
            expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
            expect(fs.readFileSync(initial.path)).toEqual(agentBefore);
          }
          if (approvalsCase) {
            if (approvalsBlocked) {
              expect(fs.readFileSync(approvalsPath, "utf8")).toBe(approvalsBefore);
              expect(() => loadExecApprovalsReadOnly()).toThrow(
                ExecApprovalsMigrationRequiredError,
              );
            } else {
              expect(fs.existsSync(approvalsPath)).toBe(false);
              expect(loadExecApprovalsReadOnly().defaults?.security).toBe("full");
            }
            if (outcome === "approvals-conflicting") {
              expect(
                readExecApprovalsConfigRow(openOpenClawStateDatabase({ env: state.env }).db)
                  ?.raw_json,
              ).toBe(serializeExecApprovals(canonicalApprovals));
            }
          }
          if (outcome === "ready" || clean || outcome === "approvals-migrated") {
            expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
          } else {
            expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
          }
        } finally {
          releaseOpenClawAgentDatabaseLease(leaseId, { env: state.env });
        }
      });
    },
  );
});
