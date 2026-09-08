import fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as launchctl from "../../daemon/launchd-exec.js";
import * as schtasks from "../../daemon/schtasks-exec.js";
import * as services from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import * as systemctl from "../../daemon/systemd-exec.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { beginUpdateRecovery, loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { captureStoppedState } from "./update-command-checkpoint.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { withUpdateCommandNativePreparation } from "./update-command-native-preparation.js";
import { withUpdateCommandNativeRestoration } from "./update-command-native-restoration.js";
import { captureUpdateCommandPreimages } from "./update-command-preimages.js";
import type { UpdateCommandRecovery } from "./update-command-recovery.js";

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
  "success",
  "lost-start-ack",
  "missing-start-readback",
  "changed-source",
  "windows-disabled",
  "windows-disabled-lost-policy-ack",
])("restores native state under the original source and executor (%s)", async (mode) => {
  const windows = mode.startsWith("windows-disabled");
  const lostPolicyAck = mode === "windows-disabled-lost-policy-ack";
  const home = await fs.realpath(dirs.make("owned-native-restore-"));
  const control = path.join(home, "control");
  await fs.mkdir(control);
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  mockSystemAccountHome();
  const pkg = await createPackageSwapFixture(home);
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
      await fs.writeFile(config, "{}\n");
      let running = true;
      let enabled = !windows;
      let recovery: UpdateCommandRecovery;
      const events: string[] = [];
      const start = vi.fn(
        async (args: Parameters<ReturnType<typeof services.resolveGatewayService>["start"]>[0]) => {
          args.assertCurrent?.();
          if (!enabled) {
            throw new Error("Disabled task cannot be run");
          }
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
            runtime: "candidate",
          });
          expect(args.preserveAutoStart).toBe(true);
          expect(events).toEqual(["enable"]);
          events.push("start");
          running = mode !== "missing-start-readback";
          if (mode === "lost-start-ack") {
            throw new Error("start acknowledgement lost");
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
            ...(running ? { pid: 32123 } : {}),
            systemd: { unit: "openclaw-gateway.service", managerUid: 2001 },
          }),
          isLoaded: async () => windows || process.platform !== "darwin" || running,
          isEnabled: async () => enabled,
          start,
        }),
      );
      const enable = async () => {
        recovery.fence.assertCurrent();
        const record = loadUpdateRecovery(run.runId, options)!;
        expect(record.nativeManager!.effects.at(-1)).toMatchObject({
          action: windows ? "enable-for-start" : "restore",
          state: "intent",
          before: { enabled: false, stopped: true },
          after: { enabled: true, stopped: true },
        });
        expect(record.effects).toEqual([]);
        events.push("enable");
        enabled = true;
        return { code: 0, stdout: "", stderr: "", termination: "exit" as const };
      };
      vi.spyOn(launchctl, "execLaunchctl").mockImplementation(async (args) => {
        expect(args[0]).toBe("enable");
        return enable();
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
          expect(record.nativeManager!.effects.at(-1)).toMatchObject({
            action: "restore",
            state: "intent",
            before: { enabled: true, stopped: false },
            after: { enabled: false, stopped: false },
          });
          expect(record.effects.at(-1)).toMatchObject({
            kind: "service-restart",
            state: "intent",
            observedIdentity: null,
          });
          enabled = false;
          events.push("disable");
          if (lostPolicyAck) {
            throw new Error("disable acknowledgement lost");
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        return enable();
      });
      vi.spyOn(systemctl, "execSystemctlUser").mockImplementation(async (_env, args) => {
        expect(args[0]).toBe("enable");
        return enable();
      });
      await withUpdateCommandExecutor(run.runId, async (executor) => {
        const fence = await executor.enter(pkg.packageRoot);
        if (windows) {
          // Select the native-manager adapter, not host filesystem/SQLite APIs.
          vi.spyOn(os, "platform").mockReturnValue("win32");
        }
        const runtime = {
          root: pkg.packageRoot,
          nodePath: process.execPath,
          version: "1.0.0",
          buildId: null,
        };
        let record = beginUpdateRecovery(
          { runId: run.runId, from: runtime, to: runtime },
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
        if (mode === "changed-source") {
          await fs.writeFile(config, '{"gateway":{"port":18791}}\n');
        }
        const probe = vi.fn(async (assertCurrent: () => void) => {
          assertCurrent();
          expect(record.nativeManager!.effects.at(-1)?.state).toBe("observed");
          expect(record.effects.at(-1)).toMatchObject({
            kind: "service-restart",
            state: "intent",
            observedIdentity: null,
          });
          expect(record.verification).toBeNull();
          expect(record.terminal).toBeUndefined();
          return "ready-to-probe";
        });
        const invoke = () =>
          withUpdateCommandNativeRestoration(
            { recovery, env, runtime: "candidate", stdout: new PassThrough() },
            probe,
          );
        if (mode === "success" || (windows && !lostPolicyAck)) {
          await expect(invoke()).resolves.toBe("ready-to-probe");
        } else {
          await expect(invoke()).rejects.toThrow();
          expect(probe).not.toHaveBeenCalled();
          if (mode === "lost-start-ack" || lostPolicyAck) {
            const effectId = record.effects.at(-1)!.effectId;
            await expect(invoke()).resolves.toBe("ready-to-probe");
            expect(record.effects.at(-1)!.effectId).toBe(effectId);
          }
        }
        if (mode === "changed-source") {
          expect(events).toEqual([]);
        } else {
          expect(events).toEqual(windows ? ["enable", "start", "disable"] : ["enable", "start"]);
          expect(enabled).toBe(!windows);
          expect(start).toHaveBeenCalledTimes(1);
        }
        if (mode === "missing-start-readback") {
          expect(record.nativeManager!.effects.at(-1)?.state).toBe("intent");
        }
        expect(record.verification).toBeNull();
        expect(record.terminal).toBeUndefined();
      });
    },
  );
});
