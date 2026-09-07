import { AsyncResource } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withConfigWriteLock } from "../../config/write-lock.js";
import * as services from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import { swapStagedPackageInstall } from "../../infra/package-update-swap.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { reopenUpdateCheckpoint } from "../../infra/update-checkpoint.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import type { UpdateCommandOptions } from "./shared.js";
import { captureStoppedState } from "./update-command-checkpoint.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { withUpdateCommandNativePreparation } from "./update-command-native-preparation.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";
import { beginUpdateCommandStartup } from "./update-command-startup.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

it.each([
  "full checkpoint",
  "checkpoint before stop",
  "checkpoint changed include",
  "verified stop",
  "unmanaged no service",
  "unmanaged appeared service",
  "changed include",
  "missing stopped readback",
  "lost native acknowledgement",
  "retry stop intent",
  "nested effect drainage",
  "caught native failure",
])("retains the exact native stop boundary: %s", async (scenario) => {
  const unmanaged = scenario.startsWith("unmanaged");
  const home = await fs.realpath(dirs.make("native-stop-startup-"));
  const control = path.join(home, "control");
  await fs.mkdir(control, { mode: 0o700 });
  vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  mockSystemAccountHome();
  const fixture = await createPackageSwapFixture(home);
  const definition = path.join(home, "gateway.service");
  await fs.writeFile(definition, "original service\n");
  await withEnvAsync(
    {
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_HOME: undefined,
      OPENCLAW_STATE_DIR: undefined,
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_SERVICE_MARKER: undefined,
      OPENCLAW_SERVICE_KIND: undefined,
      OPENCLAW_SUPERVISOR_MODE: undefined,
      OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
    },
    async () => {
      const env = { ...process.env };
      const run: NonNullable<UpdateCommandOptions["run"]> = {
        runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
        env,
      };
      const opts: UpdateCommandOptions = { run };
      const config = path.join(home, ".openclaw", "openclaw.json");
      const include = path.join(home, ".openclaw", "gateway.json");
      await fs.writeFile(config, '{"gateway":{"$include":"./gateway.json"}}\n');
      await fs.writeFile(include, '{"port":18789}\n');
      let running = true;
      let atDispatch: ReturnType<typeof loadUpdateRecovery>;
      const effectIds: Array<string | undefined> = [];
      let firstFailure: unknown;
      const entered = createDeferred();
      const release = createDeferred();
      let wroteDuringNativeEffect = false;
      let foreignBindingError: unknown;
      const stop = vi.fn(async () => {
        atDispatch = loadUpdateRecovery(run.runId, { env });
        effectIds.push(atDispatch?.nativeManager?.effects.at(-1)?.effectId);
        if (scenario === "retry stop intent" && effectIds.length === 1) {
          throw new Error("first native stop did not complete");
        }
        if (scenario === "nested effect drainage") {
          entered.resolve();
          await release.promise;
        }
        running = ["missing stopped readback", "caught native failure"].includes(scenario);
        if (scenario === "lost native acknowledgement") {
          throw new Error("native command lost its acknowledgement");
        }
      });
      vi.spyOn(services, "resolveGatewayService").mockReturnValue(
        createMockGatewayService({
          isAbsent: async () => scenario === "unmanaged no service",
          readCommand: async () => ({
            programArguments: [
              process.execPath,
              path.join(fixture.packageRoot, "dist", "index.js"),
              "gateway",
            ],
            sourcePath: definition,
          }),
          readRuntime: async () => ({
            status: running ? "running" : "stopped",
            ...(running ? { pid: 32123 } : {}),
            systemd: { unit: "openclaw-gateway.service", managerUid: 2001 },
          }),
          isLoaded: async () => process.platform !== "darwin" || running,
          isEnabled: async () => true,
          stop,
        }),
      );
      const boundary = new Error("native stop boundary complete");
      await withUpdateCommandExecutor(run.runId, async (executor) => {
        run.executorFence = await executor.enter(fixture.packageRoot);
        const result = await swapStagedPackageInstall({
          ...fixture.params,
          prepareRecovery: async (source) =>
            (
              await beginUpdateCommandStartup({
                opts,
                root: fixture.packageRoot,
                env,
                source,
                managedService: !unmanaged,
              })
            ).hooks,
          beforeActivate: async () => {
            if (scenario === "changed include") {
              await fs.writeFile(include, '{"port":18790}\n');
            }
            if (scenario === "caught native failure") {
              if (!opts.recovery) {
                throw new Error("missing startup recovery");
              }
              await withUpdateCommandNativePreparation(
                { recovery: opts.recovery, env },
                async (native) => {
                  await native
                    .stop(async () => {
                      await stop();
                    })
                    .catch(() => undefined);
                },
              );
              throw boundary;
            }
            if (scenario === "nested effect drainage") {
              if (!opts.recovery) {
                throw new Error("missing startup recovery");
              }
              const preparing = withUpdateCommandNativePreparation(
                { recovery: opts.recovery, env },
                async (native) => {
                  void native
                    .stop(async () => {
                      await stop();
                    })
                    .catch(() => undefined);
                  await entered.promise;
                },
              );
              const finished = preparing.catch((error: unknown) => error);
              if (
                !(await Promise.race([
                  entered.promise.then(() => true),
                  finished.then(() => false),
                ]))
              ) {
                throw new Error("native effect did not enter");
              }
              let wrote = false;
              const writer = withConfigWriteLock(
                include,
                async () => {
                  wrote = true;
                  await fs.writeFile(include, '{"port":18790}\n');
                },
                env,
              );
              try {
                await delay(150);
                wroteDuringNativeEffect = wrote;
              } finally {
                release.resolve();
              }
              const settled = await finished;
              await writer;
              if (settled instanceof Error) {
                throw settled;
              }
              throw boundary;
            }
            const prepare = () =>
              maybeStopManagedServiceBeforeMutableUpdate(
                Object.assign(
                  {
                    root: fixture.packageRoot,
                    updateInstallKind: "package" as const,
                    shouldRestart: true,
                    jsonMode: true,
                    phase: "prepare" as const,
                    updateRun: run,
                  },
                  { recovery: opts.recovery },
                ),
              );
            if (scenario === "retry stop intent") {
              await prepare().catch((error: unknown) => {
                firstFailure = error;
              });
            }
            if (scenario === "checkpoint before stop") {
              await captureStoppedState(opts.recovery, env);
              throw boundary;
            }
            await prepare();
            if (scenario === "checkpoint changed include") {
              await fs.writeFile(include, '{"port":18790}\n');
            }
            if (scenario === "full checkpoint" || scenario === "checkpoint changed include") {
              if (!opts.recovery) {
                throw new Error("missing startup recovery");
              }
              const outsider = new AsyncResource("foreign-capture-reader");
              const onRecord = opts.recovery.onRecord;
              opts.recovery.onRecord = (record) => {
                if (record.checkpoint) {
                  try {
                    outsider.runInAsyncScope(() =>
                      runOpenClawStateWriteTransaction(() => undefined, { env }),
                    );
                  } catch (error) {
                    foreignBindingError = error;
                  }
                }
                onRecord(record);
              };
              try {
                await captureStoppedState(opts.recovery, env);
              } finally {
                outsider.emitDestroy();
              }
            }
            throw boundary;
          },
        }).catch((error: unknown) => error);
        if (
          [
            "full checkpoint",
            "verified stop",
            "unmanaged no service",
            "retry stop intent",
            "nested effect drainage",
          ].includes(scenario)
        ) {
          expect(result).toMatchObject({ cause: boundary });
        } else {
          expect(result).toMatchObject({ cause: { name: "UpdateCommandRecoveryPendingError" } });
        }
        expect(stop).toHaveBeenCalledTimes(
          unmanaged || ["changed include", "checkpoint before stop"].includes(scenario)
            ? 0
            : scenario === "retry stop intent"
              ? 2
              : 1,
        );
        if (scenario === "retry stop intent") {
          expect(firstFailure).toMatchObject({ name: "UpdateCommandRecoveryPendingError" });
          expect(effectIds[0]).toBeDefined();
          expect(effectIds[1]).toBe(effectIds[0]);
        }
        if (scenario === "nested effect drainage") {
          expect(wroteDuringNativeEffect).toBe(false);
          expect(await fs.readFile(include, "utf8")).toBe('{"port":18790}\n');
        }
        const latest = loadUpdateRecovery(run.runId, { env });
        if (unmanaged) {
          expect(atDispatch).toBeUndefined();
          expect(latest?.nativeManager).toBeUndefined();
        } else if (["changed include", "checkpoint before stop"].includes(scenario)) {
          expect(atDispatch).toBeUndefined();
          expect(latest?.nativeManager?.effects).toEqual([]);
          expect(await fs.readFile(include, "utf8")).toBe(
            scenario === "checkpoint before stop" ? '{"port":18789}\n' : '{"port":18790}\n',
          );
        } else {
          expect(atDispatch?.nativeManager?.effects.at(-1)).toMatchObject({
            action: "stop",
            state: "intent",
            before: { stopped: false },
            after: { stopped: true },
          });
          expect(latest?.nativeManager?.effects.at(-1)).toMatchObject({
            action: "stop",
            state: ["missing stopped readback", "caught native failure"].includes(scenario)
              ? "intent"
              : "observed",
            after: { stopped: true },
          });
        }
        if (scenario === "full checkpoint") {
          expect(latest?.checkpoint).toBeDefined();
          expect(String(foreignBindingError)).toContain("state-handles");
          if (!latest?.checkpoint || !latest.preimages) {
            throw new Error("missing full checkpoint");
          }
          const reopened = await reopenUpdateCheckpoint(latest.checkpoint.ref, {
            artifactRoot: path.join(home, "..openclaw-update-checkpoints"),
            binding: latest.checkpoint.binding,
          });
          expect(reopened.manifest.preimageRef).toEqual(latest.preimages.ref);
          expect(reopened.manifest.resources).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                sourcePath: config,
                kind: "config",
                sourceBindingValidated: false,
              }),
              expect.objectContaining({
                sourcePath: include,
                kind: "config",
                sourceBindingValidated: false,
              }),
              expect.objectContaining({
                sourcePath: definition,
                kind: "service",
                sourceBindingValidated: false,
              }),
              expect.objectContaining({
                sourcePath: path.join(home, ".openclaw", "state", "openclaw.sqlite"),
                kind: "sqlite",
                artifact: expect.any(String),
              }),
            ]),
          );
        } else {
          expect(latest?.checkpoint).toBeUndefined();
        }
        expect(await fs.readFile(fixture.launcher, "utf8")).toBe("old launcher\n");
      });
    },
  );
});
