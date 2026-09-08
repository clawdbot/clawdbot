import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, vi, type Mock } from "vitest";
import { waitForFile } from "../../test/helpers/process-wait.js";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "../../test/vitest/vitest.timeouts.js";
import { writeTriageUpdateFailure } from "../commands/triage-update.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { writeRestartSentinel } from "./restart-sentinel.js";
import type { ManagedServiceBoundaryOptions } from "./update-managed-service-handoff-boundary-contract.test-support.js";
import {
  awaitEmulatedRecoveryHandoffExit,
  createManagedServiceCommandFixture,
  LAUNCHD_GATEWAY_IDENTITY_ENV,
  waitForHandoffResponse,
} from "./update-managed-service-handoff-command.test-support.js";
import {
  createManagedServiceCancellationPreload,
  createManagedServiceLaunchdClockPreload,
  createManagedServiceUpdaterFixtureScript,
  createManagedServiceManagerFixtureScript,
  type ManagedServiceCommandTiming,
  type ManagedServiceManagerBoundaryResult,
} from "./update-managed-service-handoff-lifecycle.test-support.js";
import { createManagedServiceBoundaryCleanup } from "./update-managed-service-handoff-process.test-support.js";
import {
  managedRepairUpdaterScript,
  prepareManagedRepairSpawnEnv,
  readManagedRepairEffects,
  releaseManagedRepairInference,
} from "./update-managed-service-handoff-repair.test-support.js";
import { prepareManagedServiceRuntimeFixture } from "./update-managed-service-handoff-runtime.test-support.js";
import { managedServiceStateUpdateScript } from "./update-managed-service-handoff-state.test-support.js";
import { createUpdateRun, getUpdateRun } from "./update-run-ledger.js";

type GatewayRestartSentinelDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_sentinel">;

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function readRestartSentinelPayload(env: NodeJS.ProcessEnv, key = "current"): unknown {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("gateway_restart_sentinel")
      .select(["version", "payload_json", "updated_at_ms"])
      .where("sentinel_key", "=", key),
  );
  return row
    ? { version: row.version, payload: JSON.parse(row.payload_json), revision: row.updated_at_ms }
    : null;
}

export function createManagedServiceManagerBoundary({
  spawnMock,
  tempDirs,
  cleanups,
}: {
  spawnMock: Mock;
  tempDirs: Set<string>;
  cleanups: Set<() => Promise<void>>;
}) {
  return async function runManagedServiceManagerBoundary(
    kind: "systemd" | "launchd",
    options?: ManagedServiceBoundaryOptions,
  ): Promise<ManagedServiceManagerBoundaryResult> {
    const { spawn } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
    const root = await fs.realpath(
      await fs.mkdtemp(
        path.join(
          os.tmpdir(),
          `openclaw-${kind}-manager-boundary-${options?.updaterOutput === "split-utf8" ? "安装-" : ""}`,
        ),
      ),
    );
    tempDirs.add(root);
    const commandsPath = path.join(root, "manager-commands.log");
    const statePath = path.join(root, "manager-state.json");
    const updaterPath = path.join(root, "updater-ran");
    const validationStartedPath = path.join(root, "validation-started");
    const validationReleasePath = path.join(root, "validation-release");
    const activationGatePath = path.join(root, "activation-gate");
    const activationReleasePath = path.join(root, "activation-release");
    const mutationPath = path.join(root, "cancelled-service-mutation");
    const updaterPidPath = path.join(root, "updater-pid");
    const commandTimingsPath = path.join(root, "manager-command-timings.jsonl");
    const recoveryModulePath = path.join(root, "recovery-health.mjs");
    const stateDatabasePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: root });
    const consumeNotification = `const db = new (require("node:sqlite").DatabaseSync)(${JSON.stringify(stateDatabasePath)}); const cleared = db.prepare("DELETE FROM gateway_restart_sentinel WHERE sentinel_key = 'current'").run(); db.close(); if (cleared.changes !== 1) throw new Error("expected one published notification before recovery consumed it"); ${managedServiceStateUpdateScript(statePath, "state.consumedNotifications = Number(cleared.changes)")};`;
    if (options?.updaterNotification) {
      openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    }
    await fs.writeFile(
      recoveryModulePath,
      `
    import fs from "node:fs";
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    export async function waitForGatewayUpdateRecovery(expectedVersion, expectedBuildId) {
      ${managedServiceStateUpdateScript(
        statePath,
        `
      state.healthProbed = true;
      state.healthProbeCount = (state.healthProbeCount || 0) + 1;
      state.expectedVersion = expectedVersion;
      state.expectedBuildId = expectedBuildId;
      `,
      )};
      ${options?.updaterNotification === "consumed" ? consumeNotification : ""}
      ${options?.diagnosticReadFailure === "after-recovery" ? `{ const db = new (require("node:sqlite").DatabaseSync)(${JSON.stringify(stateDatabasePath)}); db.exec("ALTER TABLE gateway_restart_sentinel RENAME COLUMN thread_id TO unreadable_thread_id"); db.close(); }` : ""}
      const fault = ${JSON.stringify(options?.gatewayHealth)};
      if (fault === "throw") throw new Error("readiness probe unavailable");
      return { healthy: !["unready", "wrong-version", "wrong-build", "exited"].includes(fault),
        runtime: { status: fault === "exited" ? "stopped" : "running", pid: fault === "exited" ? null : ${process.pid} },
        gatewayVersion: fault === "wrong-version" ? "0.0.1" : expectedVersion,
        gatewayBuildId: fault === "wrong-build" ? "another-build-same-version" : expectedBuildId };
    }
  `,
    );
    const invocationCwd = options?.relativeInput
      ? path.join(root, "invoking-directory")
      : undefined;
    if (invocationCwd) {
      await fs.mkdir(invocationCwd);
      await fs.writeFile(path.join(invocationCwd, "update-input.txt"), "selected target");
    }
    const parent = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const parentClosed = new Promise<void>((resolve) => {
      parent.once("close", () => resolve());
    });
    const parentPid = parent.pid;
    const parentStartIdentity = parentPid ? getFileLockProcessStartTime(parentPid) : null;
    if (!parentPid || parentStartIdentity === null) {
      parent.kill("SIGKILL");
      throw new Error("expected the managed Gateway parent to have a stable process identity");
    }
    await fs.writeFile(
      path.join(root, kind === "systemd" ? "systemctl" : "launchctl"),
      createManagedServiceManagerFixtureScript({
        kind,
        parentPid,
        statePath,
        commandsPath,
        configPath: path.join(root, "openclaw.json"),
        options,
      }),
      {
        mode: 0o755,
      },
    );
    const env = {
      ...process.env,
      ...(kind === "launchd" ? LAUNCHD_GATEWAY_IDENTITY_ENV : {}),
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
    };
    const run = options?.ledger
      ? createUpdateRun(
          {
            trigger: options.requester ? "chat" : "api",
            origin: options.requester ? { requester: options.requester } : {},
          },
          { env },
        )
      : undefined;
    const { sourceRuntimeImport, ledgerRuntimeImport } = await prepareManagedServiceRuntimeFixture({
      recoveryModulePath,
      statePath,
      configPath: env.OPENCLAW_CONFIG_PATH,
      activationGatePath,
      activationReleasePath,
      ledger: Boolean(run),
      options,
    });
    let helper: import("node:child_process").ChildProcess | undefined;
    let helperCompletion: Promise<number | null> | undefined;
    let helperLogPath: string | undefined;
    const cleanup = createManagedServiceBoundaryCleanup(() => [helper, parent]);
    cleanups.add(cleanup);
    try {
      await startManagedServiceUpdateHandoff({
        runId: run?.runId,
        ...(options?.beforeParkNotice ? { beforePark: async () => {} } : {}),
        root,
        restartDrainTimeoutMs: 300_000,
        parentPid,
        invocationCwd,
        requester: options?.requester,
        execPath: process.execPath,
        argv1: process.argv[1],
        handoffId: `${kind}-boundary`,
        env,
        meta: { handoffId: `${kind}-boundary` },
      });
      const [, generatedArgs, { env: childEnv }] = spawnMock.mock.calls.at(-1) as [
        string,
        string[],
        { env: NodeJS.ProcessEnv },
      ];
      const scriptPath = generatedArgs[0];
      const generatedParamsPath = generatedArgs[1];
      if (!scriptPath || !generatedParamsPath) {
        throw new Error("expected generated managed handoff script and parameters");
      }
      const generated = JSON.parse(await fs.readFile(generatedParamsPath, "utf8")) as Record<
        string,
        unknown
      >;
      helperLogPath = String(generated.logPath);
      const mockedChild = spawnMock.mock.results.at(-1)
        ?.value as import("node:child_process").ChildProcess;
      mockedChild.emit("exit", 0, null);
      tempDirs.add(path.dirname(scriptPath));
      const paramsPath = path.join(root, "manager-helper.json");
      const commandFixture = createManagedServiceCommandFixture({
        kind,
        root,
        statePath,
        stateDatabasePath,
        options,
      });
      let updaterScript = createManagedServiceUpdaterFixtureScript({
        kind,
        root,
        statePath,
        updaterPath,
        logPath: String(generated.logPath),
        stateDatabasePath,
        consumeNotification,
        options,
      });
      if (run && options?.rollbackRestoration) {
        updaterScript = `void (async () => {
          ${ledgerRuntimeImport}
          ledger.recordUpdateRunPhase(${JSON.stringify(run.runId)}, "restarting", {
            before: { version: "1.0.0" }, after: { version: "1.0.0" },
            step: { step: "previous generation restoration", status: "completed", endedAtMs: Date.now() },
          });
          ledger.recordUpdateRunVerification(${JSON.stringify(run.runId)}, {
            serviceRunning: false, pid: ${parentPid}, readyz: false, settled: false,
            channelsReady: false, pluginErrors: ["candidate plugin failed"],
          });
          ${managedServiceStateUpdateScript(statePath, "state.previousGenerationRestored = true")};
          ${updaterScript}
        })().catch((error) => { console.error(error); process.exit(18); });`;
      }
      if (run) {
        updaterScript = `void (async () => {
          ${ledgerRuntimeImport}
          ledger.recordUpdateRunPhase(${JSON.stringify(run.runId)}, "staging");
          ledger.recordUpdateRunPhase(${JSON.stringify(run.runId)}, "validating");
          ${updaterScript}
        })().catch((error) => { console.error(error); process.exit(18); });`;
      }
      if (options?.replaceLedgerWriter) {
        const installedLedgerModule = `${ledgerRuntimeImport}
        export const { finishUpdateRun } = ledger;
      `;
        updaterScript =
          `require("node:fs").writeFileSync(${JSON.stringify(recoveryModulePath)}, ${JSON.stringify(installedLedgerModule)});` +
          updaterScript;
      }
      if (invocationCwd) {
        // Consuming a relative input then removing cwd forces recovery and triage
        // to launch from the durable helper directory, not the vanished caller cwd.
        updaterScript =
          `const inputFs=require("node:fs");if(inputFs.readFileSync("update-input.txt","utf8")!=="selected target")process.exit(42);inputFs.rmSync(process.cwd(),{recursive:true});` +
          updaterScript;
      }
      if (options?.controlDisconnect === "transferred") {
        const continuation =
          options.repair && run
            ? await managedRepairUpdaterScript({
                root,
                runId: run.runId,
                sourceRuntimeImport,
                phase: options.repair.phase,
              })
            : options.validationResult
              ? `process.stdout.write(JSON.stringify({root:${JSON.stringify(root)},status:${JSON.stringify(options.validationResult === "failed" ? "error" : "skipped")},mode:"npm",reason:${JSON.stringify(options.validationResult === "failed" ? "candidate-validation-failed" : "already-current")}}));`
              : options.runnerFallback
                ? `void (async () => { ${sourceRuntimeImport} const { activateManagedServiceUpdateHandoff } = await import(${JSON.stringify(new URL("./update-managed-service-handoff.ts", import.meta.url).href)}); await activateManagedServiceUpdateHandoff(); ${updaterScript} })().catch((error) => { console.error(error); process.exit(18); });`
                : `process.stdin.once("data", (reply) => { if (reply.toString() !== "parked\\n") process.exit(18); ${updaterScript} }); process.stdout.write("park\\n");`;
        updaterScript = `
        const validationFs = require("node:fs");
        const validationStartedAt = Date.now();
        validationFs.writeFileSync(${JSON.stringify(validationStartedPath)}, "validating");
        validationFs.writeFileSync(${JSON.stringify(validationStartedPath)}, String(Date.now() - validationStartedAt));
        const gate = setInterval(() => {
          if (!validationFs.existsSync(${JSON.stringify(validationReleasePath)})) return;
          clearInterval(gate);
          ${continuation}
        }, 5);
      `;
      }
      await fs.writeFile(
        paramsPath,
        JSON.stringify({
          ...generated,
          parentPid,
          parentStartIdentity: String(parentStartIdentity),
          ...(options?.parentExitTimeoutMs === undefined
            ? {}
            : {
                parentExitDeadlineAt: Date.now() + options.parentExitTimeoutMs,
                parentExitTimeoutMs: options.parentExitTimeoutMs,
              }),
          ...(options?.overdueCommit ? { parentExitDeadlineAt: Date.now() - 1 } : {}),
          ...(options?.systemdHandoffDeadlineMs === undefined
            ? {}
            : { parentExitDeadlineAt: Date.now() + options.systemdHandoffDeadlineMs }),
          ...commandFixture,
          ...(options?.recoveryHang || options?.triageHang ? { recoveryTimeoutMs: 1000 } : {}),
          recovery: { serviceRestartSafe: true, version: "1.0.0" },
          recoveryModulePath,
          commandArgv: [process.execPath, "-e", updaterScript],
        }),
      );
      if (options?.recoverySentinel) {
        await writeRestartSentinel(
          {
            kind: "update",
            status: "error",
            ts: Date.now(),
            stats: { reason: "build failed", handoffId: `${kind}-boundary`, steps: [] },
          },
          env,
        );
      }
      if (options?.recordedFailure) {
        await writeTriageUpdateFailure(options.recordedFailure, {
          env,
          outputPath: String(generated.triageContextPath),
        });
      }
      let helperEnv = options?.repair
        ? await prepareManagedRepairSpawnEnv(root, childEnv)
        : childEnv;
      if (options?.launchdTeardown?.clockEachCommandMs || options?.recoveryClockAdvanceMs) {
        const preloadPath = path.join(root, "launchd-clock-preload.cjs");
        await fs.writeFile(
          preloadPath,
          createManagedServiceLaunchdClockPreload({
            commandTimingsPath,
            clockEachCommandMs: options.launchdTeardown?.clockEachCommandMs ?? 0,
            recoveryClockAdvanceMs: options.recoveryClockAdvanceMs,
            recoveryCommandArgv: commandFixture.recoveryCommandArgv,
          }),
        );
        helperEnv = { ...childEnv, NODE_OPTIONS: `--require ${preloadPath}` };
      }
      if (options?.runnerFallback) {
        const preloadPath = path.join(root, "spawn-fallback-preload.cjs");
        await fs.writeFile(preloadPath, "process.execve = undefined;\n");
        helperEnv = { ...helperEnv, NODE_OPTIONS: `--require ${preloadPath}` };
      }
      if (options?.validationClockAdvanceMs) {
        const preloadPath = path.join(root, "validation-clock-preload.cjs");
        await fs.writeFile(
          preloadPath,
          `const fs = require("node:fs"); const now = Date.now;
          Date.now = () => now() + (fs.existsSync(${JSON.stringify(validationStartedPath)}) ? ${options.validationClockAdvanceMs} : 0);`,
        );
        helperEnv = {
          ...helperEnv,
          NODE_OPTIONS: `${helperEnv.NODE_OPTIONS ?? ""} --require ${preloadPath}`.trim(),
        };
      }
      if (options?.cancelAtActivation) {
        const preloadPath = path.join(root, "cancel-activation-preload.cjs");
        await fs.writeFile(
          preloadPath,
          createManagedServiceCancellationPreload({
            scriptPath,
            updaterPidPath,
            activationGatePath,
            activationReleasePath,
            mutationPath,
            gateInspection: options.cancelAtActivation === "inspection",
          }),
        );
        helperEnv = { ...helperEnv, NODE_OPTIONS: `--require ${preloadPath}` };
      }
      const runningHelper = spawn(process.execPath, [scriptPath, paramsPath], {
        env: helperEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
      helper = runningHelper;
      let stdout = "";
      runningHelper.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      let stderr = "";
      runningHelper.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      let helperCompleted = false;
      const completion = new Promise<number | null>((resolve, reject) => {
        runningHelper.once("error", reject);
        runningHelper.once("close", (code) => {
          helperCompleted = true;
          resolve(code);
        });
      });
      helperCompletion = completion;
      await waitForHandoffResponse(runningHelper.stdout, "OPENCLAW_UPDATE_HANDOFF_READY");

      const databasePath = String(generated.updateLeaseDatabasePath);
      const owner = String(generated.updateLeaseOwner);
      const readLease = (): Record<string, unknown> | null => {
        const db = new DatabaseSync(databasePath, { readOnly: true });
        try {
          const row = db
            .prepare(
              "SELECT payload_json FROM managed_update_handoffs WHERE install_root = ? AND owner = ?",
            )
            .get(root, owner) as { payload_json: string } | undefined;
          return row ? (JSON.parse(row.payload_json) as Record<string, unknown>) : null;
        } finally {
          db.close();
        }
      };
      expect(readLease()).toEqual({
        version: 2,
        executor: { pid: runningHelper.pid, startIdentity: expect.any(String) },
        helper: { pid: runningHelper.pid, startIdentity: expect.any(String) },
        action: { kind: "update" },
      });
      await expect(pathExists(commandsPath)).resolves.toBe(false);
      if (options?.controlDisconnect) {
        if (options.controlDisconnect === "transferred") {
          const transferred = waitForHandoffResponse(runningHelper.stdout, "transferred");
          runningHelper.stdin?.write("transfer\n");
          await transferred;
          await expect(pathExists(commandsPath)).resolves.toBe(false);
        }
        if (options.controlDisconnect === "dead-parent") {
          parent.stdin?.end();
          await vi.waitFor(() => expect(parent.exitCode).toBe(0));
        }
        if (
          !options.cancelDuringValidation &&
          !options.cancelAtActivation &&
          !options.beforeParkNotice
        ) {
          runningHelper.stdin?.end();
        }
        if (options.controlDisconnect === "transferred") {
          // Configured plugin cold loading shares the suite saturation budget. Only
          // the updater's validation signal permits revocation or activation below.
          await waitForFile(validationStartedPath, DEFAULT_VITEST_TEST_TIMEOUT_MS);
          await expect(pathExists(commandsPath)).resolves.toBe(false);
          await expect(pathExists(validationStartedPath)).resolves.toBe(true);
          const validationClockAdvanceMs = options.validationClockAdvanceMs;
          if (validationClockAdvanceMs) {
            await vi.waitFor(async () => {
              expect(
                Number(await fs.readFile(validationStartedPath, "utf8")),
              ).toBeGreaterThanOrEqual(validationClockAdvanceMs);
            });
          }
          // A real updater child is now validating, but the service has received no stop.
          expect(parent.exitCode).toBeNull();
          expect(parent.signalCode).toBeNull();
          await expect(pathExists(commandsPath)).resolves.toBe(false);
          if (options.cancelDuringValidation) {
            const cancelled = waitForHandoffResponse(runningHelper.stdout, "cancelled");
            runningHelper.stdin?.write("cancel\n");
            await cancelled;
          } else {
            if (options.revokeWhileValidating) {
              await fs.writeFile(
                env.OPENCLAW_CONFIG_PATH,
                JSON.stringify({ commands: { ownerAllowFrom: [] } }),
              );
            }
            const notice = options.beforeParkNotice
              ? waitForHandoffResponse(runningHelper.stdout, "before-park")
              : undefined;
            await fs.writeFile(validationReleasePath, "activate");
            if (options.repair) {
              await Promise.race([
                options.repair.inferencePending,
                completion.then(() => {
                  throw new Error(`Repair updater exited before inference: ${stderr}`);
                }),
              ]);
              await releaseManagedRepairInference(options.repair, root, env.OPENCLAW_CONFIG_PATH);
            }
            if (notice) {
              await notice;
              await expect(pathExists(commandsPath)).resolves.toBe(false);
              expect(parent.exitCode).toBeNull();
              if (options.beforeParkNotice !== "stalled") {
                runningHelper.stdin?.write(
                  options.beforeParkNotice === "rejected" ? "notice-failed\n" : "noticed\n",
                );
              }
            }
            if (options.cancelAtActivation) {
              await vi.waitFor(
                async () => {
                  await expect(pathExists(activationGatePath)).resolves.toBe(true);
                },
                { timeout: 5_000 },
              );
              const cancelled = waitForHandoffResponse(runningHelper.stdout, "cancelled");
              runningHelper.stdin?.write("cancel\n");
              await cancelled;
              await fs.writeFile(activationReleasePath, "continue");
              await vi.waitFor(
                async () => {
                  expect(helperCompleted || (await pathExists(mutationPath))).toBe(true);
                },
                { timeout: 5_000 },
              );
              await expect(pathExists(mutationPath)).resolves.toBe(false);
              expect(parent.exitCode).toBeNull();
              expect(parent.signalCode).toBeNull();
            }
          }
        }
        const activated =
          options.controlDisconnect === "transferred" &&
          !options.validationResult &&
          !options.cancelDuringValidation &&
          !options.cancelAtActivation &&
          !options.revokeWhileValidating;
        if (activated) {
          await vi.waitFor(
            async () => {
              expect(JSON.parse(await fs.readFile(statePath, "utf8"))).toMatchObject({
                parked: true,
              });
            },
            // The spawn fallback imports the actual activation API before requesting the stop.
            { timeout: 30_000 },
          );
          parent.stdin?.end();
        }
        const code = await completion;
        const helperLog = await fs.readFile(String(generated.logPath), "utf8").catch(() => "");
        if (!options.repair) {
          expect(code, `${stderr}\n${helperLog}`).toBe(options.helperExitCode ?? 0);
        }
        await expect(pathExists(updaterPath)).resolves.toBe(activated);
      } else if (options?.parentExitTimeoutMs !== undefined) {
        const timeout = options.parentExitTimeoutMs + (options.launchdTeardown ? 8_000 : 3_000);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          expect(
            await Promise.race([
              completion,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error("managed helper did not restore the stalled parent")),
                  timeout,
                );
              }),
            ]),
            stderr,
          ).toBe(0);
        } finally {
          clearTimeout(timer);
        }
        expect(parent.signalCode).toBeNull();
        expect(parent.exitCode).toBeNull();
        await expect(pathExists(commandsPath)).resolves.toBe(false);
        expect(stdout).not.toContain("committed\n");
        await expect(pathExists(updaterPath)).resolves.toBe(false);
      } else if (options?.launchdFault === "wrong-parent") {
        const cancelled = waitForHandoffResponse(runningHelper.stdout, "cancelled");
        runningHelper.stdin?.write("park\n");
        await cancelled;
        expect(await completion, stderr).toBe(0);
        expect(parent.exitCode).toBeNull();
        expect(parent.signalCode).toBeNull();
        await expect(pathExists(updaterPath)).resolves.toBe(false);
      } else if (options?.overdueCommit) {
        const cancelled = waitForHandoffResponse(runningHelper.stdout, "cancelled");
        runningHelper.stdin?.write("park\n");
        await cancelled;
        expect(await completion, stderr).toBe(0);
        expect(parent.exitCode).toBeNull();
        expect(parent.signalCode).toBeNull();
        await expect(pathExists(updaterPath)).resolves.toBe(false);
      } else {
        const parked = waitForHandoffResponse(runningHelper.stdout, "parked");
        runningHelper.stdin?.write("park\n");
        await parked;
        expect(parent.exitCode).toBeNull();
        await expect(pathExists(updaterPath)).resolves.toBe(false);
        if (options?.cancelAfterPark) {
          const restoring = waitForHandoffResponse(runningHelper.stdout, "restore-after-exit");
          runningHelper.stdin?.write("cancel\n");
          await restoring;
          expect(stdout).not.toContain("committed\n");
          parent.stdin?.end();
          expect(await completion, stderr).toBe(0);
          await expect(pathExists(updaterPath)).resolves.toBe(false);
        } else {
          const committed = waitForHandoffResponse(runningHelper.stdout, "committed");
          runningHelper.stdin?.write("commit\n");
          await committed;
          parent.stdin?.end();
          const code = await completion;
          const helperLog = await fs.readFile(String(generated.logPath), "utf8").catch(() => "");
          expect
            .soft(code, `${stderr}\n${helperLog}`)
            .toBe(
              options?.helperExitCode ??
                (options?.systemdHandoffFailure ? 1 : (options?.updaterExitCode ?? 7)),
            );
          await expect(pathExists(updaterPath)).resolves.toBe(
            !options?.systemdHandoffFailure && !options?.revokeOwner,
          );
        }
      }
      expect(readLease()).toBeNull();
      if (options?.diagnosticReadFailure) {
        const db = new DatabaseSync(stateDatabasePath);
        db.exec(
          "ALTER TABLE gateway_restart_sentinel RENAME COLUMN unreadable_thread_id TO thread_id",
        );
        db.close();
      }
      const contextPath = String(generated.triageContextPath);
      const savedFailure = (await pathExists(contextPath))
        ? {
            path: contextPath,
            mode: (await fs.stat(contextPath)).mode & 0o777,
            contents: JSON.parse(await fs.readFile(contextPath, "utf8")),
          }
        : null;
      return {
        ...(options?.repair
          ? {
              repairEffects: readManagedRepairEffects(root),
              helperExitCode: runningHelper.exitCode,
            }
          : {}),
        ...(run ? { run: getUpdateRun(run.runId, { env }) } : {}),
        commands: (await fs.readFile(commandsPath, "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .filter(Boolean),
        parentSignal: parent.signalCode,
        state: JSON.parse(await fs.readFile(statePath, "utf8").catch(() => "{}")) as Record<
          string,
          unknown
        >,
        sentinel: readRestartSentinelPayload({ OPENCLAW_STATE_DIR: root }),
        log: await fs.readFile(String(generated.logPath), "utf8"),
        savedFailure,
        sensitiveFilesRemoved: (
          await Promise.all((generated.sensitivePaths as string[]).map(pathExists))
        ).every((exists) => !exists),
        commandTimings: (await fs.readFile(commandTimingsPath, "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as ManagedServiceCommandTiming),
      };
    } catch (error) {
      const helperLog = helperLogPath
        ? await fs.readFile(helperLogPath, "utf8").catch(() => "")
        : "";
      throw new Error(`${String(error)}\n${helperLog.slice(-8192)}`, { cause: error });
    } finally {
      parent.stdin?.end();
      if (options?.cancelAtActivation) {
        await fs.writeFile(activationReleasePath, "continue");
        const updaterPid = Number(await fs.readFile(updaterPidPath, "utf8").catch(() => ""));
        if (updaterPid > 0) {
          try {
            process.kill(-updaterPid, "SIGKILL");
          } catch {}
        }
        // Let the helper reap native commands after their parent exits; killing it
        // first orphans manager fixtures that can write during directory cleanup.
        await parentClosed;
        await helperCompletion;
      }
      await cleanup();
      if (options?.recoveryChecksServiceIdentity) {
        await awaitEmulatedRecoveryHandoffExit(statePath);
      }
    }
  };
}
