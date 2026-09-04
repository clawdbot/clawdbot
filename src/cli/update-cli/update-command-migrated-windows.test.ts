import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { asResolvedSourceConfig, asRuntimeConfig } from "../../config/materialize.js";
import type { GatewayService } from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import {
  continueMigratedUpdateInFreshProcess,
  type MigratedUpdateFinalizationInput,
} from "./update-command-migrated.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

const mocks = vi.hoisted(() => ({
  service: vi.fn<() => GatewayService>(),
  enabled: true,
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: mocks.service,
}));
vi.mock("../../daemon/schtasks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/schtasks.js")>()),
  suspendScheduledTaskAutoStartForUpdate: vi.fn<
    typeof import("../../daemon/schtasks.js").suspendScheduledTaskAutoStartForUpdate
  >(async (_env, options) => {
    const enabled = mocks.enabled;
    if (enabled) {
      await options?.beforeMutation?.();
    }
    mocks.enabled = false;
    return enabled;
  }),
  resumeScheduledTaskAutoStartAfterUpdate: vi.fn<
    typeof import("../../daemon/schtasks.js").resumeScheduledTaskAutoStartAfterUpdate
  >(async (_env, options) => {
    await options?.beforeMutation?.();
    mocks.enabled = true;
    return true;
  }),
}));
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runUtf8CommandWithTimeout: vi.fn(),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  mockSystemAccountHome();
  mocks.enabled = true;
});
afterEach(() => vi.restoreAllMocks());

it.each([
  "launch failure",
  "failed terminal result",
  "replaced task",
  "changed protected task",
] as const)("keeps Windows autostart suspended across migrated finalizer %s", async (outcome) => {
  const home = await fs.realpath(dirs.make("migrated-windows-"));
  await withEnvAsync(
    {
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, "AppData"),
      OPENCLAW_HOME: undefined,
      OPENCLAW_STATE_DIR: undefined,
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_SUPERVISOR_MODE: undefined,
      OPENCLAW_SERVICE_MARKER: undefined,
      OPENCLAW_SERVICE_KIND: undefined,
    },
    async () => {
      mockProcessPlatform("win32");
      const root = process.cwd();
      let programArguments = [process.execPath, path.join(root, "openclaw.mjs"), "gateway"];
      mocks.service.mockReturnValue(
        createMockGatewayService({
          readCommand: async () => ({
            programArguments,
            environment: { HOME: home },
          }),
          readRuntime: async () => ({ status: "running" }),
          isLoaded: async () => true,
        }),
      );
      const stopped = await maybeStopManagedServiceBeforeMutableUpdate({
        root,
        updateInstallKind: "package",
        shouldRestart: true,
        jsonMode: true,
      });
      const recovery = stopped.windowsTaskAutoStartRecovery;
      expect(recovery).toBeDefined();
      if (outcome === "changed protected task" && stopped.serviceUpdateVerdict?.kind === "owned") {
        stopped.serviceUpdateVerdict.refreshDefinition = false;
      }
      recovery?.beginMutation();
      let enabledAtWorkerStart: boolean | undefined;
      vi.mocked(runUtf8CommandWithTimeout).mockImplementationOnce(async (_argv, options) => {
        enabledAtWorkerStart = mocks.enabled;
        if (outcome === "launch failure") {
          throw new Error("candidate finalizer unavailable");
        }
        if (outcome === "replaced task" || outcome === "changed protected task") {
          mocks.enabled = true;
          programArguments =
            outcome === "replaced task"
              ? [process.execPath, path.join(home, "other-install", "openclaw.mjs"), "gateway"]
              : [...programArguments, "--port", "20000"];
          throw new Error("candidate finalizer disappeared");
        }
        assert(typeof options === "object");
        const input = JSON.parse(String(options.input)) as MigratedUpdateFinalizationInput; // SAFETY: The real typed parent serializes this private worker input.
        expect(input.windowsTaskAutoStartSuspended).toBe(true);
        expect(input.params.preManagedServiceStop).not.toHaveProperty(
          "windowsTaskAutoStartRecovery",
        );
        await fs.writeFile(
          input.resultPath,
          JSON.stringify({
            result: {
              ...input.params.result,
              status: "error",
              reason: "plugin-convergence-failed",
            },
            terminalRunId: "migrated-windows-run",
            exitCode: 1,
          }),
        );
        return {
          stdout: "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        };
      });
      const runId = "migrated-windows-run";
      const operation = continueMigratedUpdateInFreshProcess(
        {
          root,
          result: { status: "ok", mode: "npm", root, runId, steps: [], durationMs: 0 },
          installKindChanged: false,
          configSnapshot: {
            path: path.join(home, "openclaw.json"),
            exists: false,
            raw: null,
            parsed: {},
            sourceConfig: asResolvedSourceConfig({}),
            resolved: asResolvedSourceConfig({}),
            valid: true,
            runtimeConfig: asRuntimeConfig({}),
            config: asRuntimeConfig({}),
            issues: [],
            warnings: [],
            legacyIssues: [],
          },
          requestedChannel: null,
          storedChannel: "stable",
          channel: "stable",
          downgradeRisk: false,
          shouldRestart: true,
          opts: { json: true, run: { runId, env: { ...process.env } } },
          preManagedServiceStop: stopped,
          controlPlaneUpdateSentinelMeta: null,
          preUpdatePluginInstallRecords: {},
          startedAt: Date.now(),
          packageUpdateNodeRunner: process.execPath,
          updateStepTimeoutMs: 1_000,
          rollbackBlockedReason: "state-migrated-no-rollback",
        },
        [],
      );
      try {
        if (outcome === "launch failure") {
          await expect(operation).rejects.toThrow("candidate finalizer unavailable");
        } else if (outcome === "replaced task" || outcome === "changed protected task") {
          await expect(operation).rejects.toThrow(/ownership or manager identity changed/);
        } else {
          await expect(operation).resolves.toMatchObject({ exitCode: 1 });
        }
        expect(enabledAtWorkerStart).toBe(false);
        const replaced = outcome === "replaced task" || outcome === "changed protected task";
        expect(mocks.enabled).toBe(replaced);
        await recovery?.restore();
        expect(mocks.enabled).toBe(replaced);
      } finally {
        await recovery?.complete(false);
      }
    },
  );
});
