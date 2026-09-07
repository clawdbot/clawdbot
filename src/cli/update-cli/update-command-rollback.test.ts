import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { stopChildProcess } from "../../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createConfigIO } from "../../config/config.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import {
  captureUpdateDoctorConfigWrites,
  writeUpdatePostInstallDoctorResult,
} from "../../infra/update-doctor-result.js";
import { NativePackageRollbackError } from "../../infra/update-native-package-stage.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import type { PreManagedServiceStop } from "./update-command-service.js";
import { createWindowsTaskAutoStartRecovery } from "./update-command-windows-task.js";

const mocks = vi.hoisted(() => ({
  stop: vi.fn(),
  restart: vi.fn<typeof import("./update-command-service.js").maybeRestartService>(),
  reachable: vi.fn(),
  execSchtasks: vi.fn<typeof import("../../daemon/schtasks-exec.js").execSchtasks>(),
}));
vi.mock("../../daemon/schtasks-exec.js", () => ({ execSchtasks: mocks.execSchtasks }));
vi.mock("./update-command-service-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-maintenance.js")>()),
  createWindowsTaskAutoStartGuard: () => async () => {},
}));
vi.mock("./update-command-service-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-command.js")>()),
  runUpdatedInstallGatewayCommand: async () => "accepted",
}));
vi.mock("./update-command-service.js", () => ({
  maybeStopManagedServiceBeforeMutableUpdate: mocks.stop,
  maybeRestartService: mocks.restart,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate: async (
    stopped: PreManagedServiceStop | undefined,
    safe: boolean,
    guard?: () => Promise<void>,
  ) => stopped?.windowsTaskAutoStartRecovery?.restore(safe, guard),
  resolveUpdatedGatewayRestartPort: async () => 19101,
}));
vi.mock("../daemon-cli/restart-health-probe.js", () => ({
  confirmGatewayReachable: mocks.reachable,
}));
import * as updateShared from "./shared.js";
import { inspectActivatedUpdateState } from "./update-command-migrated.js";
import * as packageModule from "./update-command-package.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";
import { completeUpdateCommandRun } from "./update-command-run.js";
import { resolveUpdateResultNextAction } from "./update-recovery-guidance.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let candidateRoot: string;
let previousRoot: string;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
async function readPreviousConfig(env: NodeJS.ProcessEnv) {
  return createConfigIO({ env, pluginValidation: "skip" }).readConfigFileSnapshot();
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
    previousRoot = fs.realpathSync(dirs.make("rollback-previous-runtime-"));
    candidateRoot = fs.realpathSync(dirs.make("rollback-candidate-runtime-"));
    for (const [root, version] of [
      [previousRoot, "2026.9.1"],
      [candidateRoot, "2026.9.3"],
    ] as const) {
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ type: "module", version }),
      );
    }
    const worker = "dist/infra/update-candidate-state.worker.js";
    fs.mkdirSync(path.dirname(path.join(candidateRoot, worker)), { recursive: true });
    fs.writeFileSync(
      path.join(candidateRoot, worker),
      `import ${JSON.stringify(pathToFileURL(path.resolve(worker)).href)};\n`,
    );
    vi.resetAllMocks();
    mocks.reachable.mockResolvedValue({ reachable: true });
    mocks.stop.mockResolvedValue({
      stopped: true,
      stoppedAtMs: 100,
      serviceUpdateVerdict: {
        kind: "owned",
        root: candidateRoot,
        fingerprint: "fixture",
        refreshDefinition: true,
      },
    });
    mocks.restart.mockImplementation(async ({ onVerified }) => {
      onVerified?.(125);
      return "ok";
    });
  });
  it.each([
    { reachable: true, duringStop: false },
    { reachable: false, duringStop: false },
    { reachable: true, duringStop: true },
  ])(
    "records refused project rollback (reachable=$reachable, during stop=$duringStop)",
    async ({ reachable, duringStop }) => {
      const env = { OPENCLAW_STATE_DIR: dirs.make("rollback-project-changed-") };
      const configSnapshot = await readPreviousConfig(env);
      const config = configSnapshot.sourceConfigBeforeMigrations ?? configSnapshot.sourceConfig;
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      const schemaVersions = await readUpdateStateSchemaVersions({
        stateDir: env.OPENCLAW_STATE_DIR,
        config,
        env,
      });
      const rollback = vi.fn(async () => ({
        name: "global install rollback",
        activePackageRoot: candidateRoot,
        command: "restore",
        cwd: candidateRoot,
        durationMs: 1,
        exitCode: 1,
        reason: "rollback-project-changed" as const,
        stderrTail: detail,
      }));
      mocks.reachable.mockResolvedValue({ reachable });
      const detail = "Global project changed since staging: sibling";
      const outcome = await rollbackFailedUpdate({
        result: {
          status: "error",
          mode: "pnpm",
          root: candidateRoot,
          reason: "readyz-unhealthy",
          steps: [],
          durationMs: 1,
        },
        previousRoot,
        schemaVersions,
        configSnapshot,
        opts: { json: true, run },
        timeoutMs: 1_000,
        preManagedServiceStop: {
          stopped: true,
          inspected: true,
          runtimeInspected: true,
          running: true,
          serviceEnv: env,
        },
        packageTransaction: {
          backupRoot: "/backup",
          assertRollbackSafe: async () => {
            if (!duringStop) {
              throw new NativePackageRollbackError(detail);
            }
          },
          rollback,
          complete: vi.fn(),
        },
      });
      expect(outcome.result).toMatchObject({
        status: "error",
        reason: "rollback-project-changed",
        root: candidateRoot,
      });
      expect(rollback).toHaveBeenCalledTimes(duringStop ? 1 : 0);
      expect(mocks.stop).toHaveBeenCalledTimes(!reachable || duringStop ? 1 : 0);
      expect(mocks.restart).not.toHaveBeenCalled();
      completeUpdateCommandRun(outcome.result, run);
      const row = getUpdateRun(run.runId, { env })!;
      expect(row).toMatchObject({
        status: "failed",
        reason: "rollback-project-changed",
        steps: expect.arrayContaining([
          expect.objectContaining({ step: "package rollback", status: "failed", detail }),
        ]),
      });
      const nextAction = resolveUpdateResultNextAction({
        result: outcome.result,
        serviceRunning: reachable,
        env,
      });
      expect(renderUpdateRunReport(row, { nextAction }).markdown).toContain(
        "Keep the candidate installed if its gateway is reachable; otherwise keep the gateway stopped.",
      );
    },
  );
  it.each([
    { activated: false, healthy: true },
    { activated: false, healthy: false },
    { activated: true, healthy: true },
    { activated: true, healthy: false },
  ])(
    "retains Windows suspension through rollback (activated=$activated, healthy=$healthy)",
    async ({ activated, healthy }) => {
      const stateDir = dirs.make("rollback-windows-owner-");
      const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_WINDOWS_TASK_NAME: "rollback-fixture" };
      const configSnapshot = await readPreviousConfig(env);
      const config = configSnapshot.sourceConfigBeforeMigrations ?? configSnapshot.sourceConfig;
      const schemaVersions = await readUpdateStateSchemaVersions({ stateDir, config, env });
      let enabled = true;
      const actions: string[] = [];
      mocks.execSchtasks.mockImplementation(async (args) => {
        if (args[0] === "/Query") {
          return {
            code: 0,
            stdout: `<Task><Settings><Enabled>${enabled}</Enabled></Settings></Task>`,
            stderr: "",
          };
        }
        const action = args[0] === "/Run" ? "/Run" : args.at(-1)!;
        actions.push(action);
        if (action === "/Run") {
          return { code: enabled ? 0 : 1, stdout: "", stderr: enabled ? "" : "task disabled" };
        }
        enabled = action === "/ENABLE";
        return { code: 0, stdout: "", stderr: "" };
      });
      const original = createWindowsTaskAutoStartRecovery({ serviceEnv: env });
      await original.suspended;
      original.beginMutation();
      if (activated) {
        await original.restore(true);
      }
      let fresh: ReturnType<typeof createWindowsTaskAutoStartRecovery> | undefined;
      const service = {
        stopped: true,
        inspected: true,
        runtimeInspected: true,
        running: false,
        serviceEnv: env,
        serviceUpdateVerdict: {
          kind: "owned" as const,
          root: previousRoot,
          fingerprint: "fixture",
          refreshDefinition: false,
        },
      };
      mocks.stop.mockImplementationOnce(async () => {
        fresh = createWindowsTaskAutoStartRecovery({ serviceEnv: env });
        const suspended = await fresh.suspended;
        if (!suspended) {
          await fresh.complete();
        }
        return { ...service, windowsTaskAutoStartRecovery: suspended ? fresh : undefined };
      });
      mocks.restart.mockImplementationOnce(async ({ refreshServiceEnv }) => {
        expect(refreshServiceEnv).toBe(false);
        const running = await mocks.execSchtasks(["/Run", "/TN", "rollback-fixture"]);
        if (running.code !== 0) {
          throw new Error(running.stderr);
        }
        return healthy ? "ok" : "restart-health-failed";
      });
      try {
        const outcome = await rollbackFailedUpdate({
          result: {
            status: "error",
            mode: "npm",
            root: candidateRoot,
            reason: "doctor-failed",
            before: { version: "2026.9.1" },
            after: { version: "2026.9.3" },
            steps: [],
            durationMs: 1,
          },
          previousRoot,
          schemaVersions,
          previousVerified: true,
          packageTransaction: {
            backupRoot: "/backup",
            complete: vi.fn(async () => {}),
            rollback: async () => ({
              name: "package rollback",
              activePackageRoot: previousRoot,
              command: "restore",
              cwd: previousRoot,
              exitCode: 0,
              durationMs: 1,
            }),
          },
          configSnapshot,
          opts: { json: true },
          preManagedServiceStop: { ...service, windowsTaskAutoStartRecovery: original },
          timeoutMs: 1_000,
        });
        expect(enabled).toBe(true);
        expect(outcome.rolledBack).toBe(healthy);
        const retained = outcome.stoppedForRollback?.windowsTaskAutoStartRecovery;
        expect(retained).toBe(activated ? fresh : original);
        await retained?.complete(healthy);
        expect(enabled).toBe(healthy);
        expect(actions.slice(-2)).toEqual(healthy ? ["/ENABLE", "/Run"] : ["/Run", "/DISABLE"]);
      } finally {
        await fresh?.complete(false);
        await original.complete(false);
      }
    },
  );
  it.each([
    { change: "none", previousVerified: true, restored: true, service: "stopped" },
    ...(process.platform === "win32"
      ? []
      : [
          { change: "readonly-config", previousVerified: true, restored: true, service: "stopped" },
        ]),
    { change: "doctor", previousVerified: true, restored: true, service: "stopped" },
    { change: "doctor-unchanged", previousVerified: true, restored: true, service: "stopped" },
    { change: "doctor-missing-input", previousVerified: true, restored: false, service: "stopped" },
    { change: "doctor-include", previousVerified: true, restored: true, service: "stopped" },
    { change: "doctor-include-edit", previousVerified: true, restored: false, service: "stopped" },
    { change: "doctor-input-edit", previousVerified: true, restored: false, service: "stopped" },
    { change: "doctor-capture-edit", previousVerified: true, restored: false, service: "stopped" },
    { change: "doctor-operator-edit", previousVerified: true, restored: false, service: "stopped" },
    { change: "doctor-locked-edit", previousVerified: true, restored: false, service: "stopped" },
    { change: "doctor-stop-edit", previousVerified: true, restored: false, service: "stopped" },
    { change: "doctor-restore-edit", previousVerified: true, restored: false, service: "stopped" },
    { change: "new-agent", previousVerified: true, restored: true, service: "stopped" },
    { change: "new-agent-foreign", previousVerified: true, restored: false, service: "stopped" },
    {
      change: "new-agent-previous-incompatible",
      previousVerified: true,
      restored: false,
      service: "stopped",
    },
    {
      change: "new-agent-previous-unknown",
      previousVerified: true,
      restored: false,
      service: "stopped",
    },
    { change: "identity-read-failed", previousVerified: true, restored: true, service: "stopped" },
    { change: "shared", previousVerified: true, restored: false, service: "stopped" },
    { change: "new-shared-deferred", previousVerified: true, restored: false, service: "stopped" },
    { change: "agent", previousVerified: true, restored: false, service: "stopped" },
    { change: "during-stop", previousVerified: true, restored: false, service: "stopped" },
    { change: "unknown-runtime", previousVerified: true, restored: false, service: "stopped" },
    { change: "none", previousVerified: false, restored: false, service: "stopped" },
    { change: "none", previousVerified: true, restored: false, service: "absent" },
    { change: "none", previousVerified: true, restored: false, service: "no-restart" },
  ])(
    "$change schema change; previous verified=$previousVerified; service=$service",
    async ({ change, previousVerified, restored, service }) => {
      const stateDir = dirs.make("update-schema-rollback-");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const configPath = path.join(stateDir, "openclaw.json");
      const includePath = path.join(stateDir, "logging.json");
      const authored = {
        gateway: { mode: "local" },
        agents: { defaults: { models: { "openai/gpt-5.6-luna": {} } } },
        ...(change.startsWith("doctor-include") ? { logging: { $include: "./logging.json" } } : {}),
      };
      const originalRaw = `// Fresh install: Doctor has never run.\n${JSON.stringify(authored, null, 2)}\n`;
      if (change.startsWith("doctor-include")) {
        fs.writeFileSync(includePath, '{"level":"info"}\n');
      }
      if (change.startsWith("doctor") || change === "readonly-config") {
        fs.writeFileSync(configPath, originalRaw, { mode: 0o600 });
      }
      const configSnapshot = await createConfigIO({
        env: process.env,
        pluginValidation: "skip",
      }).readConfigFileSnapshot();
      const config = configSnapshot.sourceConfigBeforeMigrations ?? configSnapshot.sourceConfig;
      let activationConfig: { path: string; raw: string | null; hash: string } | undefined;
      const shared = path.join(stateDir, "state/openclaw.sqlite");
      const agent = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
      if (change !== "new-shared-deferred") {
        setVersion(shared, 7);
      }
      if (!change.startsWith("new-agent")) {
        setVersion(agent, 3);
      }
      const schemaVersions = await readUpdateStateSchemaVersions({ stateDir, config: {} });
      if (change === "new-shared-deferred") {
        expect(schemaVersions.find((entry) => entry.path === shared)?.userVersion).toBeNull();
        setVersion(shared, 7);
        const database = new DatabaseSync(shared);
        try {
          database.exec(`
            CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER);
            INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '8', 0);
          `);
        } finally {
          database.close();
        }
      }
      if (change.startsWith("new-agent")) {
        setVersion(agent, change === "new-agent-foreign" ? 4 : 3);
      }
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
        root: change === "unknown-runtime" ? undefined : candidateRoot,
        before: { version: "2026.9.1" },
        after: { version: "2026.9.3" },
        steps: [],
        durationMs: 10,
      };
      const operatorEdit = () =>
        fs.appendFileSync(configPath, "\n// Operator edit after activation.\n");
      if (change.startsWith("doctor")) {
        fs.writeFileSync(path.join(candidateRoot, "dist/entry.js"), "export {};\n");
        vi.spyOn(updateShared, "runUpdateStep").mockImplementationOnce(async (step) => {
          if (change === "doctor-input-edit") {
            fs.writeFileSync(
              configPath,
              JSON.stringify({ ...authored, logging: { level: "debug" } }),
            );
          }
          await captureUpdateDoctorConfigWrites(configPath, async (capture) => {
            const io = createConfigIO({ env: process.env, pluginValidation: "skip" });
            const input = await io.readConfigFileSnapshot();
            if (change !== "doctor-unchanged") {
              await io.writeConfigFile(
                {
                  ...(input.sourceConfigBeforeMigrations ?? input.sourceConfig),
                  meta: {
                    migrations: { modelPolicyAllowlist: true },
                    lastTouchedVersion: "2026.9.3",
                  },
                  agents: {
                    defaults: {
                      ...authored.agents.defaults,
                      modelPolicy: { allow: ["openai/gpt-5.6-luna"] },
                    },
                  },
                  wizard: { lastRunVersion: "2026.9.3", lastRunCommand: "doctor" },
                },
                {
                  baseSnapshot: input,
                  lastTouchedVersionOverride: "2026.9.3",
                  skipPluginValidation: true,
                },
              );
            }
            if (change === "doctor-capture-edit") {
              operatorEdit();
            }
            await writeUpdatePostInstallDoctorResult({
              resultPath: step.env!.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH!,
              result: {
                status: "ok",
                configHash: capture.hash,
                ...(change === "doctor-missing-input"
                  ? {}
                  : { configInputHash: capture.inputHash }),
              },
            });
          });
          return {
            name: "openclaw doctor",
            command: "doctor",
            cwd: candidateRoot,
            durationMs: 1,
            exitCode: 0,
          };
        });
        await packageModule.runPackageUpdateDoctor({
          root: candidateRoot,
          timeoutMs: 1_000,
          progress: {},
          managedServiceEnv: process.env,
          onConfigSnapshot: (snapshot) => {
            activationConfig = snapshot;
          },
        });
        expect(fs.readFileSync(`${configPath}.pre-update`, "utf8")).toBe(originalRaw);
        const inspected = { ...result, status: "ok" as const };
        expect(
          await inspectActivatedUpdateState({
            result: inspected,
            root: candidateRoot,
            schemaVersions,
            candidateSchemaVersions: { state: change === "new-shared-deferred" ? 8 : 7, agent: 3 },
            config,
            env: process.env,
          }),
        ).toBeUndefined();
        expect(inspected.status).toBe("ok");
        if (change === "doctor-include-edit") {
          fs.writeFileSync(includePath, '{"level":"debug"}\n');
        }
        if (change === "doctor-operator-edit") {
          operatorEdit();
        }
        if (change === "doctor-stop-edit") {
          mocks.stop.mockImplementationOnce(async () => {
            operatorEdit();
            return { stopped: true };
          });
        }
      }
      const rollback = vi.fn(async () => {
        if (change === "doctor-restore-edit") {
          operatorEdit();
        }
        return {
          name: "rollback",
          activePackageRoot: previousRoot,
          command: "restore",
          cwd: previousRoot,
          exitCode: 0,
          durationMs: 1,
        };
      });
      if (change === "identity-read-failed") {
        vi.spyOn(packageModule, "readPackageUpdateIdentity").mockRejectedValueOnce(
          new Error("Diagnostic identity read failed after verified restoration"),
        );
      }
      let finishWriter: (() => Promise<void>) | undefined;
      if (change === "doctor-locked-edit") {
        const script = path.join(candidateRoot, "config-writer.mjs");
        fs.writeFileSync(
          script,
          `
          import { withFileLock } from ${JSON.stringify(pathToFileURL(path.resolve("src/infra/file-lock.ts")).href)};
          import { appendFile } from "node:fs/promises";
          const commit = new Promise(resolve => process.once("message", resolve));
          await withFileLock(process.argv[2], {
            retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1 }, stale: 30_000,
          }, async () => {
            process.send("locked");
            await commit;
            await appendFile(process.argv[2], "\\n// Operator edit after activation.\\n");
          });
          process.disconnect();
        `,
        );
        const writer = fork(script, [configPath], {
          execArgv: ["--import", path.resolve("scripts/tsx.mjs")],
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        });
        onTestFinished(() => stopChildProcess(writer, 1_000));
        const exited = once(writer, "exit");
        let requested = false;
        finishWriter = async () => {
          if (!requested && writer.connected) {
            requested = true;
            writer.send("commit");
          }
          const [code] = await exited;
          expect(code).toBe(0);
        };
        await Promise.race([
          once(writer, "message").then(([message]) => expect(message).toBe("locked")),
          exited.then(([code]) => {
            throw new Error(`Config writer exited before locking: ${code}`);
          }),
        ]);
        const open = fs.promises.open.bind(fs.promises);
        const rename = fs.promises.rename.bind(fs.promises);
        const lockPath = `${fs.realpathSync(configPath)}.lock`;
        // Commit at lock contention, or at an unprotected publication after its
        // final read. The operator holds the same cross-process lock as config set.
        vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
          if (String(args[0]) === lockPath) {
            await finishWriter?.();
          }
          return open(...args);
        });
        vi.spyOn(fs.promises, "rename").mockImplementation(async (...args) => {
          if (String(args[1]) === configPath) {
            await finishWriter?.();
          }
          return rename(...args);
        });
      }
      if (change === "readonly-config") {
        fs.chmodSync(stateDir, 0o500);
      }
      let outcome: Awaited<ReturnType<typeof rollbackFailedUpdate>>;
      try {
        outcome = await rollbackFailedUpdate({
          result,
          previousRoot,
          nodeRunner: process.execPath,
          configSnapshot,
          activationConfig,
          schemaVersions,
          candidateSchemaVersions: { state: change === "new-shared-deferred" ? 8 : 7, agent: 3 },
          previousSchemaVersions:
            change === "new-agent-previous-unknown"
              ? undefined
              : {
                  state: 7,
                  agent: change === "new-agent-previous-incompatible" ? 2 : 3,
                },
          previousVerified,
          packageTransaction: { backupRoot: "/backup", rollback, complete: vi.fn() },
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
                    root: previousRoot,
                    fingerprint: "fixture",
                    refreshDefinition: true,
                  },
                },
          timeoutMs: 1_000,
        });
      } finally {
        await finishWriter?.();
        if (change === "readonly-config") {
          const mode = fs.statSync(stateDir).mode & 0o777;
          fs.chmodSync(stateDir, 0o700);
          expect(mode).toBe(0o500);
        }
      }
      if (change === "readonly-config") {
        expect(rollback).toHaveBeenCalledOnce();
        expect(fs.readFileSync(configPath, "utf8")).toBe(originalRaw);
      }
      if (change === "doctor" || change === "doctor-unchanged" || change === "doctor-include") {
        expect(fs.readFileSync(configPath, "utf8")).toBe(originalRaw);
        if (process.platform !== "win32") {
          expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
        }
      }
      if (change.startsWith("doctor-") && change.endsWith("edit")) {
        if (change === "doctor-input-edit") {
          expect(fs.readFileSync(configPath, "utf8")).toContain('"debug"');
        } else if (change === "doctor-include-edit") {
          expect(fs.readFileSync(includePath, "utf8")).toContain('"debug"');
        } else {
          expect(fs.readFileSync(configPath, "utf8")).toContain("Operator edit after activation");
        }
        expect(
          resolveUpdateResultNextAction({ result: outcome.result, env: process.env }),
        ).toContain(configPath);
      }
      expect(outcome.rolledBack).toBe(restored);
      expect(rollback, JSON.stringify(outcome)).toHaveBeenCalledTimes(
        change === "none" ||
          change === "readonly-config" ||
          change === "doctor" ||
          change === "doctor-unchanged" ||
          change === "doctor-include" ||
          change === "doctor-locked-edit" ||
          change === "doctor-restore-edit" ||
          change === "identity-read-failed" ||
          change === "new-agent"
          ? 1
          : 0,
      );
      expect(mocks.restart).toHaveBeenCalledTimes(restored ? 1 : 0);
      if (service !== "stopped") {
        expect(mocks.stop).not.toHaveBeenCalled();
        expect(mocks.reachable).not.toHaveBeenCalled();
        expect(outcome.result).toMatchObject({
          root: previousRoot,
          after: result.before,
          reason: result.reason,
          recovery: { serviceRestartSafe: false, packageRollbackVerified: true },
        });
        return;
      }
      if (restored) {
        expect(outcome).toMatchObject({ verifiedAtMs: 125 });
        expect(mocks.restart).toHaveBeenCalledWith(
          expect.objectContaining({ nodeRunner: "/previous/node" }),
        );
        expect(outcome.result).toMatchObject({
          root: previousRoot,
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
          change === "unknown-runtime" ||
            change === "new-shared-deferred" ||
            change.startsWith("new-agent-previous-")
            ? "rollback-state-unverified"
            : previousVerified
              ? "state-migrated-no-rollback"
              : "previous-version-unverified",
        );
        if (!previousVerified) {
          expect(outcome.result).toMatchObject({ root: previousRoot, after: result.before });
        }
        if (change.startsWith("new-agent-previous-")) {
          expect(outcome.result).toMatchObject({ root: candidateRoot, after: result.after });
          expect(mocks.stop).not.toHaveBeenCalled();
        }
      }
    },
  );

  it("leaves a failed rollback's task recovery with finalization", async () => {
    const complete = vi.fn(async () => {});
    const stopped = {
      stopped: true,
      windowsTaskAutoStartRecovery: {
        suspended: Promise.resolve(true),
        handoff: () => {},
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
        root: candidateRoot,
        steps: [],
        durationMs: 1,
      },
      previousRoot,
      rollbackBlockedReason: "state-migrated-no-rollback",
      configSnapshot: await readPreviousConfig({
        OPENCLAW_STATE_DIR: dirs.make("rollback-blocked-config-"),
      }),
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

  it.each([
    "source-failed",
    "restored-shims-failed",
    "partial-restore",
    "restart-unhealthy",
    "restart-refused",
    "restart-threw",
  ] as const)("retains active installation identity after %s", async (failure) => {
    const restoredPackage = failure !== "source-failed" && failure !== "partial-restore";
    const rollbackSucceeded = failure.startsWith("restart-");
    const activePackageRoot =
      failure === "partial-restore" ? null : restoredPackage ? previousRoot : candidateRoot;
    const stateDir = dirs.make("rollback-source-failed-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const configSnapshot = await readPreviousConfig(env);
    const config = configSnapshot.sourceConfigBeforeMigrations ?? configSnapshot.sourceConfig;
    const schemaVersions = await readUpdateStateSchemaVersions({ stateDir, config, env });
    const result: UpdateRunResult = {
      status: "error",
      mode: "npm",
      root: candidateRoot,
      reason: "readyz-unhealthy",
      steps: [],
      durationMs: 1,
      before: { version: "2026.9.1" },
      after: { version: "2026.9.3" },
    };
    if (failure === "restart-threw") {
      mocks.restart.mockRejectedValueOnce(new Error("Service restart transport failed"));
    } else {
      mocks.restart.mockResolvedValueOnce(
        failure === "restart-unhealthy" ? "restart-health-failed" : "failed",
      );
    }
    const outcome = await rollbackFailedUpdate({
      result,
      previousRoot,
      configSnapshot,
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
          activePackageRoot,
          command: "restore",
          cwd: previousRoot,
          exitCode: rollbackSucceeded ? 0 : 1,
          durationMs: 1,
        })),
      },
    });
    expect(outcome.result).toMatchObject({
      root: activePackageRoot ?? undefined,
      after:
        activePackageRoot === null ? undefined : restoredPackage ? result.before : result.after,
      reason: rollbackSucceeded ? result.reason : "source-rollback-failed",
      steps: [
        expect.objectContaining({
          name: "rollback",
          exitCode: rollbackSucceeded ? 0 : 1,
        }),
      ],
      ...(!rollbackSucceeded
        ? {}
        : {
            recovery: { serviceRestartSafe: true, packageRollbackVerified: true },
          }),
    });
    expect(outcome.rolledBack).toBe(false);
    expect(mocks.restart).toHaveBeenCalledTimes(rollbackSucceeded ? 1 : 0);
  });
});
