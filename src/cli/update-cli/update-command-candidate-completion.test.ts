import fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readConfigFileSnapshot, writeConfigFile } from "../../config/config.js";
import * as launchctl from "../../daemon/launchd-exec.js";
import * as schtasks from "../../daemon/schtasks-exec.js";
import * as services from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import * as systemctl from "../../daemon/systemd-exec.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import * as packageRecovery from "../../infra/package-update-recovery.js";
import { swapStagedPackageInstall } from "../../infra/package-update-swap.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { buildCheckpointReaderRuntime } from "../../infra/update-checkpoint-runtime.test-support.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { createUpdateRecoveryPackageHooks } from "../../infra/update-run-recovery-package.js";
import {
  beginUpdateRecovery,
  loadUpdateRecovery,
  prepareUpdateRecoveryHandoff,
  acceptUpdateRecoveryHandoff,
} from "../../infra/update-run-recovery.js";
import { rawDataToString } from "../../infra/ws.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import * as healthProbe from "../daemon-cli/restart-health.js";
import { completeUpdateCommandCandidate } from "./update-command-candidate-completion.js";
import { captureStoppedState } from "./update-command-checkpoint.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { runUpdateCommandMutation } from "./update-command-mutation.js";
import { withUpdateCommandNativePreparation } from "./update-command-native-preparation.js";
import {
  interruptSealedReplay,
  useShortRealReplayLeases,
} from "./update-command-pending-replay.test-support.js";
import type { FinishUpdateParams } from "./update-command-post-update.js";
import { captureUpdateCommandPreimages } from "./update-command-preimages.js";
import * as recoveryApi from "./update-command-recovery.js";
import type { UpdateCommandRecovery } from "./update-command-recovery.js";
import { UpdateCommandFinalizedRecoveryFailure } from "./update-command-result.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: vi.fn(actual.platform) };
});
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});
it.each([
  "replay-displaced",
  "replay-conflict",
  "replay-shadowed",
  "rollback",
  "rollback-old",
  "rollback-interrupted",
  "rollback-interference",
  "success",
  "status-only",
  "windows-disabled",
  "launchd-disabled",
  "health-rollback",
  "start-rollback",
  "unapplied-start-rollback",
  "readiness-rollback",
  "readiness-failed",
  "boot-switched",
  "close-during-package-read",
])(
  "completes a real package transaction only under current serving authority (%s)",
  async (mode) => {
    vi.mocked(os.platform).mockReturnValue(process.platform);
    const home = await fs.realpath(dirs.make("owned-native-restore-"));
    const control = path.join(home, "control");
    await fs.mkdir(control);
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    mockSystemAccountHome();
    const pkg = await createPackageSwapFixture(home);
    const windows = mode === "windows-disabled";
    const disabled = windows || mode === "launchd-disabled";
    const older = mode === "rollback-old";
    const interference = mode === "rollback-interference";
    const interrupted = mode === "rollback-interrupted";
    const replay = mode.startsWith("replay-");
    const rollback = mode === "rollback" || older || interference || interrupted || replay;
    if (replay) {
      useShortRealReplayLeases();
    }
    const lateRollback = [
      "health-rollback",
      "start-rollback",
      "unapplied-start-rollback",
      "readiness-rollback",
    ].includes(mode);
    if (rollback || lateRollback) {
      await buildCheckpointReaderRuntime(pkg.packageRoot, false, false, {
        selfContained: true,
        preWorkshop: older,
      });
    }
    let servingVersion = rollback ? "1.0.0" : "2.0.0";
    let servingBoot = rollback ? "previous-boot" : "candidate-boot";
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => {
      server.once("listening", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing fixture port");
    }
    let peer: WebSocket | undefined;
    server.on("connection", (socket) => {
      peer = socket;
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "fixture-nonce", ts: Date.now() },
        }),
      );
      socket.on("message", (data) => {
        const frame = JSON.parse(rawDataToString(data)) as { id: string; method: string };
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload:
              frame.method === "connect"
                ? {
                    type: "hello-ok",
                    protocol: 4,
                    server: { version: servingVersion, bootId: servingBoot, connId: "fixture" },
                    features: { methods: ["health"], events: ["shutdown"] },
                    snapshot: {
                      presence: [],
                      health: {},
                      stateVersion: { presence: 1, health: 1 },
                      uptimeMs: 1,
                    },
                    auth: { role: "operator", scopes: ["operator.read"] },
                    policy: {
                      maxPayload: 524288,
                      maxBufferedBytes: 1048576,
                      tickIntervalMs: 30000,
                    },
                  }
                : { ok: true },
          }),
        );
      });
    });
    try {
      const definition = path.join(home, "gateway.service");
      await fs.writeFile(definition, "original service\n");
      await withEnvAsync(
        {
          HOME: home,
          USERPROFILE: home,
          OPENCLAW_HOME: undefined,
          OPENCLAW_STATE_DIR: path.join(home, "state"),
          OPENCLAW_CONFIG_PATH: path.join(home, "state", "openclaw.json"),
          OPENCLAW_PROFILE: undefined,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_SERVICE_MARKER: undefined,
          OPENCLAW_SERVICE_KIND: undefined,
          OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
        },
        async () => {
          const env = { ...process.env };
          const options = { env };
          const run = createUpdateRun({ trigger: "cli" }, options);
          const config = env.OPENCLAW_CONFIG_PATH!;
          await fs.writeFile(
            config,
            JSON.stringify({
              gateway: { port: address.port, auth: { mode: "token", token: "fixture-only-token" } },
            }) + "\n",
          );
          let resume: (() => Promise<void>) | undefined;
          let running = true;
          let enabled = !disabled;
          let recovery: UpdateCommandRecovery;
          const events: string[] = [];
          const start = vi.fn(
            async (
              args: Parameters<ReturnType<typeof services.resolveGatewayService>["start"]>[0],
            ) => {
              args.assertCurrent?.();
              const record = loadUpdateRecovery(run.runId, options)!;
              const native = record.nativeManager!.effects.at(-1)!;
              expect(native).toMatchObject({
                action: "restore",
                state: "intent",
                before: { stopped: true },
                after: { stopped: false, enabled: true },
              });
              expect(record.effects.at(-1)).toMatchObject({
                effectId: native.effectId,
                kind: "service-restart",
                state: "intent",
                runtime:
                  rollback || (lateRollback && record.primaryFailure) ? "previous" : "candidate",
              });
              expect(args.preserveAutoStart).toBe(true);
              expect(events.at(-1)).toBe("enable");
              events.push("start");
              const previous = record.effects.at(-1)!.runtime === "previous";
              servingVersion = previous ? "1.0.0" : "2.0.0";
              servingBoot = previous ? "previous-boot" : "candidate-boot";
              running = previous || mode !== "unapplied-start-rollback";
              if (!previous && (mode === "start-rollback" || mode === "unapplied-start-rollback")) {
                throw new Error("candidate start acknowledgement lost");
              }
            },
          );
          vi.spyOn(services, "resolveGatewayService").mockReturnValue(
            createMockGatewayService({
              readCommand: async () => ({
                programArguments: [
                  process.execPath,
                  path.join(pkg.packageRoot, "dist", "index.js"),
                  "gateway",
                ],
                sourcePath: definition,
              }),
              readRuntime: async () => ({
                status: running ? "running" : "stopped",
                ...(running ? { pid: process.pid } : {}),
                systemd: { unit: "openclaw-gateway.service", managerUid: 2001 },
              }),
              isLoaded: async () => windows || os.platform() !== "darwin" || running,
              isEnabled: async () => enabled,
              start,
              stop: async (args) => {
                args.assertCurrent?.();
                const state = recovery.getRecord();
                expect(state.primaryFailure).not.toBeNull();
                expect(state.nativeManager!.effects.at(-1)).toMatchObject({
                  action: "stop",
                  state: "intent",
                  before: { stopped: false },
                  after: { stopped: true },
                });
                events.push("stop");
                running = false;
              },
            }),
          );
          const enable = async () => {
            if (!replay) {
              recovery.fence.assertCurrent();
            }
            const record = loadUpdateRecovery(run.runId, options)!;
            expect(record.nativeManager!.effects.at(-1)).toMatchObject({
              action: disabled ? "enable-for-start" : "restore",
              state: "intent",
              before: { enabled: false, stopped: true },
              after: { enabled: true, stopped: true },
            });
            expect(
              record.effects.every(
                (effect) => effect.state === "observed" || effect.state === "cancelled",
              ),
            ).toBe(true);
            expect(record.effects.at(-1)?.kind).toBe(
              rollback || (lateRollback && record.primaryFailure)
                ? "checkpoint-restore"
                : "runtime-mutation",
            );
            events.push("enable");
            enabled = true;
            return { code: 0, stdout: "", stderr: "", termination: "exit" as const };
          };
          const disable = async () => {
            recovery.fence.assertCurrent();
            expect(recovery.getRecord().nativeManager!.effects.at(-1)).toMatchObject({
              action: "suppress",
              state: "intent",
              after: { enabled: false },
            });
            expect(recovery.getRecord().primaryFailure).not.toBeNull();
            events.push("disable");
            enabled = false;
            return { code: 0, stdout: "", stderr: "", termination: "exit" as const };
          };
          const restoreDisabledPolicy = async () => {
            const observed = loadUpdateRecovery(run.runId, options)!;
            expect(observed.effects.at(-1)).toMatchObject({
              kind: "service-restart",
              state: "intent",
              observedIdentity: null,
            });
            expect(observed.nativeManager!.effects.at(-1)).toMatchObject({
              action: "restore",
              state: "intent",
              after: { enabled: false, stopped: false },
            });
            events.push("disable");
            enabled = false;
            return { code: 0, stdout: "", stderr: "", termination: "exit" as const };
          };
          vi.spyOn(launchctl, "execLaunchctl").mockImplementation(async (args) => {
            expect(["enable", "disable"]).toContain(args[0]);
            return args[0] === "disable"
              ? disabled && running
                ? restoreDisabledPolicy()
                : disable()
              : enable();
          });
          vi.spyOn(schtasks, "execSchtasks").mockImplementation(async (args) => {
            if (args[0] === "/Query") {
              return {
                code: 0,
                stdout: `<Task><Settings><Enabled>${enabled}</Enabled></Settings></Task>`,
                stderr: "",
              };
            }
            expect(args[0]).toBe("/Change");
            if (args.includes("/DISABLE")) {
              const record = loadUpdateRecovery(run.runId, options)!;
              const observed = loadUpdateRecovery(run.runId, options)!;
              expect(observed.effects.at(-1)).toMatchObject({
                kind: "service-restart",
                state: "intent",
                observedIdentity: null,
              });
              expect(record.nativeManager!.effects.at(-1)).toMatchObject({
                action: "restore",
                state: "intent",
                after: { enabled: false, stopped: false },
              });
              events.push("disable");
              enabled = false;
              return { code: 0, stdout: "", stderr: "" };
            }
            return enable();
          });
          vi.spyOn(systemctl, "execSystemctlUser").mockImplementation(async (_env, args) => {
            expect(["enable", "disable"]).toContain(args[0]);
            return args[0] === "disable" ? disable() : enable();
          });
          await withUpdateCommandExecutor(run.runId, async (executor) => {
            const fence = await executor.enter(pkg.packageRoot);
            if (disabled) {
              vi.spyOn(os, "platform").mockReturnValue(windows ? "win32" : "darwin");
            }
            const runtime = {
              root: pkg.packageRoot,
              nodePath: process.execPath,
              version: "1.0.0",
              buildId: null,
            };
            let record = beginUpdateRecovery(
              { runId: run.runId, from: runtime, to: { ...runtime, version: "2.0.0" } },
              fence,
              options,
            );
            recovery = {
              fence,
              options,
              getRecord: () => record,
              onRecord: (next) => {
                fence.assertCurrent();
                record = next;
              },
              assertReady: () => {
                throw new Error("No serving proof");
              },
            };
            if (older) {
              closeOpenClawStateDatabaseForTest();
              const previous = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath(env));
              try {
                previous.exec(`PRAGMA foreign_keys=OFF;
                  DROP TABLE skill_workshop_proposal_events;
                  DROP TABLE skill_workshop_proposal_rollbacks;
                  DROP TABLE skill_workshop_collection_reviews;
                  DROP TABLE skill_workshop_proposals;
                  PRAGMA user_version=15;
                  UPDATE schema_meta SET schema_version=15 WHERE meta_key='primary';`);
              } finally {
                previous.close();
              }
            }
            await captureUpdateCommandPreimages({ recovery, env, managedService: true });
            await withUpdateCommandNativePreparation({ recovery, env }, async (native) => {
              await native.suppress(async (assertCurrent) => {
                assertCurrent();
                enabled = false;
              });
              await native.stop(async (assertCurrent) => {
                assertCurrent();
                running = false;
              });
            });
            await captureStoppedState(recovery, env);
            const hooks = createUpdateRecoveryPackageHooks(recovery);
            const swapped = await swapStagedPackageInstall({ ...pkg.params, recovery: hooks });
            expect(swapped.status, JSON.stringify(swapped)).toBe("committed");
            const prepared = prepareUpdateRecoveryHandoff(record, fence, options);
            recovery.onRecord(
              acceptUpdateRecoveryHandoff(prepared.handoff, record.to, fence, options),
            );
            let migratedVersion: unknown;
            for (const phase of ["doctor", "plugins", "post-plugin-doctor"] as const) {
              const mutation = await runUpdateCommandMutation({
                recovery,
                env,
                phase,
                timeoutMs: 30_000,
                run: async (assertCurrent) => {
                  assertCurrent();
                  if (older) {
                    migratedVersion = runOpenClawStateWriteTransaction(
                      ({ db }) => db.prepare("PRAGMA user_version").get()?.user_version,
                      options,
                    );
                  }
                  if (rollback || lateRollback) {
                    const original = JSON.parse(await fs.readFile(config, "utf8"));
                    await writeConfigFile({ ...original, update: { channel: "beta" } });
                    if (rollback) {
                      throw new Error("fixture candidate Doctor failed after config write");
                    }
                  }
                },
              });
              if (rollback) {
                expect(mutation).toHaveProperty("error");
                expect(JSON.parse(await fs.readFile(config, "utf8")).update.channel).toBe("beta");
                break;
              }
              expect(mutation).toHaveProperty("value");
            }
            if (older) {
              expect(migratedVersion).toBe(16);
            }
            let interruptedPackageId: string | undefined;
            if (interrupted) {
              const descriptor = record.package!.descriptor;
              const opened = await packageRecovery.reopenPackageUpdateTransaction({
                descriptor,
                expectedLiveRoot: record.from.root,
                expectedBinDir: descriptor.binDir,
                expectedTransactionId: record.transactionId,
                hooks: {
                  ...hooks,
                  async beforeEffect(effect, context) {
                    const receipt = await hooks.beforeEffect(effect, context);
                    return {
                      ...receipt,
                      afterEffect: async () => {
                        throw new Error("process lost before restore observation");
                      },
                    };
                  },
                },
              });
              expect(opened.status).toBe("ready");
              if (opened.status !== "ready") {
                throw new Error("No actual package owner");
              }
              const outcome = await opened.transaction.rollback();
              expect(outcome.status).toBe("unavailable");
              interruptedPackageId = record.effects.at(-1)!.effectId;
              expect(record.effects.at(-1)).toMatchObject({
                kind: "package-restore",
                state: "intent",
              });
              expect((await opened.transaction.observe()).status).toBe("verified");
            }

            const health = {
              healthy: true,
              runtime: {
                status: "running" as const,
                ...(mode === "status-only" ? {} : { pid: process.pid }),
              },
              gatewayVersion: servingVersion,
              gatewayBuildId: null,
              gatewayBootId: servingBoot,
              staleGatewayPids: [],
              activatedPluginErrors: [],
              channelProbeErrors: [],
              portUsage: {
                port: address.port,
                status: "busy" as const,
                listeners: [{ pid: process.pid }],
                hints: [],
              },
            };
            vi.spyOn(healthProbe, "waitForGatewayHealthyRestart").mockImplementation(async () => {
              const healthRecord = loadUpdateRecovery(run.runId, options)!;
              expect(healthRecord.effects.at(-1)).toMatchObject({
                kind: "service-restart",
                state: "intent",
              });
              expect(healthRecord.nativeManager!.effects.at(-1)!.state).toBe("observed");
              return {
                ...health,
                gatewayVersion: servingVersion,
                gatewayBootId: servingBoot,
                healthy: !(mode === "health-rollback" && servingBoot === "candidate-boot"),
              };
            });
            vi.spyOn(healthProbe, "waitForGatewayHttpReadiness").mockImplementation(async () => ({
              healthz: 200,
              readyz:
                mode === "readiness-failed" ||
                (mode === "readiness-rollback" && servingBoot === "candidate-boot")
                  ? 503
                  : 200,
            }));
            vi.spyOn(healthProbe, "inspectGatewayRestart").mockImplementation(async () => ({
              ...health,
              gatewayVersion: servingVersion,
              gatewayBootId: servingBoot,
              ...(mode === "boot-switched" ? { gatewayBootId: "replaced-boot" } : {}),
            }));
            let closedDuringRead = false;
            const originalOpen = packageRecovery.reopenPackageUpdateTransaction;
            vi.spyOn(packageRecovery, "reopenPackageUpdateTransaction").mockImplementation(
              async (input) => {
                const opened = await originalOpen(input);
                if (mode === "close-during-package-read" && !closedDuringRead) {
                  closedDuringRead = true;
                  await new Promise<void>((resolve) => {
                    peer!.once("close", resolve);
                    peer!.close();
                  });
                }
                return opened;
              },
            );
            const params: FinishUpdateParams = {
              mutationStarted: true,
              result: {
                status: "ok",
                mode: "npm",
                root: pkg.packageRoot,
                steps: [],
                durationMs: 0,
                runId: run.runId,
              },
              root: pkg.packageRoot,
              installKindChanged: false,
              configSnapshot: await readConfigFileSnapshot({
                observe: false,
                skipPluginValidation: true,
              }),
              requestedChannel: null,
              storedChannel: "stable",
              channel: "stable",
              downgradeRisk: false,
              shouldRestart: true,
              opts: {
                json: true,
                yes: true,
                run: { runId: run.runId, env, executorFence: fence },
                recovery,
              },
              controlPlaneUpdateSentinelMeta: null,
              preUpdatePluginInstallRecords: {},
              startedAt: Date.now(),
              packageUpdateNodeRunner: process.execPath,
              updateStepTimeoutMs: 30_000,
            };
            if (replay) {
              resume = await interruptSealedReplay(
                params,
                mode === "replay-conflict",
                mode === "replay-shadowed",
              );
              expect(start).not.toHaveBeenCalled();
              return;
            }
            if (interrupted) {
              const priorOnRecord = recovery.onRecord;
              recovery.onRecord = (next) => {
                priorOnRecord(next);
                const restores = next.effects.filter((effect) => effect.kind === "package-restore");
                expect(restores.map((effect) => effect.effectId)).toEqual([interruptedPackageId]);
              };
            }
            if (interference) {
              const originalReplay = recoveryApi.replayUpdateCommandRecovery;
              vi.spyOn(recoveryApi, "replayUpdateCommandRecovery").mockImplementation(
                async (replayOptions) => {
                  const actual = await originalReplay(replayOptions);
                  if (actual.status === "verified") {
                    await fs.writeFile(config, JSON.stringify({ operatorChange: "must remain" }));
                  }
                  return actual;
                },
              );
              await expect(completeUpdateCommandCandidate(params)).rejects.toThrow(
                /Original source changed/,
              );
              expect(record.terminal).toBeUndefined();
              expect(record.restore?.phase).toBe("observed");
              expect(getUpdateRun(run.runId, options)?.status).toBe("running");
              expect(JSON.parse(await fs.readFile(config, "utf8"))).toEqual({
                operatorChange: "must remain",
              });
              expect(start).not.toHaveBeenCalled();
            } else if (rollback || lateRollback) {
              const outcome = await completeUpdateCommandCandidate(params).catch(
                (error: unknown) => error,
              );
              expect(outcome, inspect(outcome, { depth: 12 })).toBeInstanceOf(
                UpdateCommandFinalizedRecoveryFailure,
              );
              expect(record.terminal).toMatchObject({
                status: "rolled-back",
                receipt: { runtime: "previous", gateway: { bootId: servingBoot } },
              });
              expect(record.retainedPair).toBeUndefined();
              expect(getUpdateRun(run.runId, options)?.status).toBe("rolled-back");
              expect(await fs.readFile(pkg.launcher, "utf8")).toBe("old launcher\n");
              expect(JSON.parse(await fs.readFile(config, "utf8")).update).toBeUndefined();
              expect(record.restore?.phase).toBe("observed");
              if (older) {
                closeOpenClawStateDatabaseForTest();
                const restored = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath(env), {
                  readOnly: true,
                });
                try {
                  expect(restored.prepare("PRAGMA user_version").get()?.user_version).toBe(15);
                  expect(
                    restored
                      .prepare("SELECT schema_version FROM schema_meta WHERE meta_key='primary'")
                      .get()?.schema_version,
                  ).toBe(15);
                  expect(
                    restored
                      .prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'skill_workshop_%'")
                      .all(),
                  ).toEqual([]);
                } finally {
                  restored.close();
                }
              }
            } else if (mode === "success" || mode === "status-only" || disabled) {
              await expect(completeUpdateCommandCandidate(params)).resolves.toMatchObject({
                status: "ok",
              });
              expect(record.terminal).toMatchObject({
                status: "succeeded",
                receipt: { gateway: { bootId: "candidate-boot" } },
              });
              expect(record.retainedPair?.state).toBe("selected");
              expect(getUpdateRun(run.runId, options)?.status).toBe("succeeded");
              expect(await fs.readFile(pkg.launcher, "utf8")).toBe("candidate launcher\n");
            } else {
              await expect(completeUpdateCommandCandidate(params)).rejects.toThrow();
              expect(record.terminal).toBeUndefined();
              expect(record.retainedPair).toBeUndefined();
              expect(getUpdateRun(run.runId, options)?.status).toBe("running");
            }
            if (lateRollback) {
              expect(events).toEqual(
                mode === "unapplied-start-rollback"
                  ? ["enable", "start", "disable", "enable", "start"]
                  : ["enable", "start", "disable", "stop", "enable", "start"],
              );
              expect(start).toHaveBeenCalledTimes(2);
              const candidateRestart = record.effects.find(
                (effect) => effect.kind === "service-restart" && effect.runtime === "candidate",
              )!;
              expect(candidateRestart.state).toBe(
                mode === "readiness-rollback" ? "observed" : "cancelled",
              );
              if (candidateRestart.state === "cancelled") {
                expect(candidateRestart.observedIdentity).toBeNull();
              }
            } else if (
              ["readiness-failed", "boot-switched", "close-during-package-read"].includes(mode)
            ) {
              expect(events).toEqual(["enable", "start", "disable", "stop"]);
              expect(running).toBe(false);
            } else {
              expect(events).toEqual(
                interference ? [] : disabled ? ["enable", "start", "disable"] : ["enable", "start"],
              );
            }
            if (disabled) {
              expect(record.nativeManager!.original.enabled).toBe(false);
              expect(record.nativeManager!.effects.at(-1)!.after.enabled).toBe(false);
              expect(enabled).toBe(false);
            }
            expect(recovery.assertReady).toThrow("No serving proof");
          });
          await resume?.();
          if (replay) {
            expect(start).toHaveBeenCalledTimes(
              mode === "replay-conflict" || mode === "replay-shadowed" ? 0 : 1,
            );
          }
        },
      );
    } finally {
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
);
