import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, type Mock } from "vitest";
import { readConfigFileSnapshot } from "../../config/config.js";
import { ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV } from "../../config/future-version-guard.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { VERSION } from "../../version.js";
import { runDaemonRestart } from "../daemon-cli/lifecycle.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import { finishUpdate } from "./update-command-post-update.js";
import { UpdateCommandFailure } from "./update-command-result.js";
import {
  maybeRestartService,
  maybeStopManagedServiceBeforeMutableUpdate,
} from "./update-command-service.js";

export function registerGenerationRecoveryTests(
  fixture: () => {
    root: string;
    configPath: string;
    mocks: {
      child: Mock<typeof import("../../process/exec.js").runCommandWithTimeout>;
      health: Mock<typeof import("../daemon-cli/restart-health.js").waitForGatewayHealthyRestart>;
      running: boolean;
      events: string[];
      stopAllowances: Array<string | undefined>;
      writeJson: Mock;
    };
  },
) {
  it("records a stopped service when activation throws before health verification", async () => {
    const { root, mocks } = fixture();
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, ".openclaw") };
    const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    recordUpdateRunVerification(
      run.runId,
      { serviceRunning: true, runningVersion: VERSION },
      { env },
    );
    const before = await maybeStopManagedServiceBeforeMutableUpdate({
      root,
      updateInstallKind: "package",
      shouldRestart: true,
      jsonMode: true,
    });
    mocks.child.mockRejectedValueOnce(new Error("candidate gateway exited 70"));
    expect(
      await maybeRestartService({
        shouldRestart: true,
        result: {
          status: "ok",
          mode: "npm",
          root,
          before: { version: VERSION },
          after: { version: "9999.1.1" },
          steps: [],
          durationMs: 0,
        },
        opts: { json: true, run },
        refreshServiceEnv: false,
        serviceUpdateVerdict: before.serviceUpdateVerdict,
        serviceEnv: before.serviceEnv,
        gatewayPort: 19305,
        requireRunningServiceAfterRestart: true,
        timeoutMs: 1000,
      }),
    ).toBe("failed");
    const record = getUpdateRun(run.runId, { env })!;
    expect(record.verification.serviceRunning).toBe(false);
    expect(renderUpdateRunReport({ ...record, status: "failed" }).headline).not.toContain(
      "gateway is running",
    );
  });

  it.each([false, true])(
    "restores the previous running generation after candidate stamp advancement (content changed=%s)",
    async (contentChanged) => {
      const { root, configPath, mocks } = fixture();
      process.env.OPENCLAW_UPDATE_RUN_HANDOFF = "1";
      const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, ".openclaw") };
      const run = {
        runId: createUpdateRun({ trigger: "cli", before: { version: VERSION } }, { env }).runId,
        env,
      };
      const configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
      const schemas = await readUpdateStateSchemaVersions({
        stateDir: env.OPENCLAW_STATE_DIR,
        config: configSnapshot.config,
        env,
      });
      recordUpdateRunVerification(
        run.runId,
        {
          serviceRunning: true,
          runningVersion: VERSION,
          versionMatch: true,
          settled: true,
          readyz: true,
          channelsReady: true,
          pluginErrors: [],
        },
        { env },
      );
      const before = await maybeStopManagedServiceBeforeMutableUpdate({
        root,
        updateInstallKind: "package",
        shouldRestart: true,
        jsonMode: true,
        updateRun: run,
      });
      const previousBytes = await fs.readFile(path.join(root, "dist/index.js"));
      await fs.writeFile(
        path.join(root, "dist/index.js"),
        "throw new Error('candidate activation');\n",
      );
      const candidateConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
      candidateConfig.meta.lastTouchedVersion = "9999.1.1";
      if (contentChanged) {
        candidateConfig.gateway.port = 19306;
      }
      await fs.writeFile(configPath, JSON.stringify(candidateConfig));
      let restores = 0;
      mocks.child.mockImplementation(async (_args, options) => {
        if (restores === 0) {
          expect(
            typeof options === "object" &&
              options.env?.[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV],
          ).toBeUndefined();
          mocks.running = false;
          throw new Error("candidate gateway exited 70");
        }
        expect(
          typeof options === "object" && options.env?.[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV],
        ).toBe("1");
        expect(JSON.parse(await fs.readFile(configPath, "utf8")).meta.lastTouchedVersion).toBe(
          VERSION,
        );
        expect(await fs.readFile(path.join(root, "dist/index.js"))).toEqual(previousBytes);
        // Exercise the previous binary's real lifecycle/version guard with the child env.
        const healthy = await withOwnedManagedUpdateEnv(
          typeof options === "object" ? options.env : undefined,
          () => runDaemonRestart({ json: true, preserveDefinition: true }),
        );
        return {
          code: healthy ? 0 : 1,
          stdout: JSON.stringify(mocks.writeJson.mock.lastCall?.[0]),
          stderr: "",
          signal: null,
          killed: false,
          termination: "exit",
        };
      });
      mocks.health.mockImplementation(async ({ port, expectedVersion }) => ({
        healthy: mocks.running,
        gatewayBootId: "service-boot",
        staleGatewayPids: [],
        runtime: { status: mocks.running ? "running" : "stopped" },
        gatewayVersion: mocks.running ? VERSION : undefined,
        expectedVersion: expectedVersion ?? undefined,
        portUsage: { port, status: mocks.running ? "busy" : "free", listeners: [], hints: [] },
      }));
      const result = {
        status: "ok" as const,
        mode: "npm" as const,
        root,
        before: { version: VERSION },
        after: { version: "9999.1.1" },
        steps: [],
        durationMs: 0,
      };
      let completedStatus: string | undefined;
      const error = await finishUpdate({
        result,
        root,
        configSnapshot,
        installKindChanged: false,
        requestedChannel: null,
        storedChannel: "stable",
        channel: "stable",
        downgradeRisk: false,
        shouldRestart: true,
        opts: { json: true, run },
        preManagedServiceStop: before,
        controlPlaneUpdateSentinelMeta: null,
        preUpdatePluginInstallRecords: {},
        startedAt: Date.now(),
        updateStepTimeoutMs: 1000,
        schemaVersions: schemas,
        previousVerified: true,
        packageTransaction: {
          backupRoot: path.join(root, "backup"),
          rollback: async () => {
            restores++;
            await fs.writeFile(path.join(root, "dist/index.js"), previousBytes);
            return {
              name: "package rollback",
              activePackageRoot: root,
              command: "restore",
              cwd: root,
              exitCode: 0,
              durationMs: 1,
            };
          },
          complete: async () => {
            completedStatus = getUpdateRun(run.runId, { env })?.status;
          },
        },
      }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(UpdateCommandFailure);
      const record = getUpdateRun(run.runId, { env })!;
      expect(process.env[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV]).toBeUndefined();
      expect(before.serviceEnv?.[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV]).toBeUndefined();
      if (contentChanged) {
        expect(restores).toBe(0);
        expect(record.reason).toBe("state-migrated-no-rollback");
        expect(record.status).toBe("failed");
        expect(record.verification.serviceRunning).toBe(false);
        expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual(candidateConfig);
      } else {
        expect(restores).toBe(1);
        expect(mocks.running).toBe(true);
        expect(mocks.stopAllowances).toEqual([undefined, "1"]);
        expect(record).toMatchObject({
          status: "rolled-back",
          after: { version: VERSION },
          verification: { serviceRunning: true, runningVersion: VERSION },
        });
        expect(completedStatus).toBe("rolled-back");
        expect(record.downtimeMs).toBeGreaterThanOrEqual(0);
        expect(record.confirmedAtMs).toBeGreaterThanOrEqual(before.stoppedAtMs!);
        expect(renderUpdateRunReport(record).headline).toBe(
          `↩️ OpenClaw update rolled back to ${VERSION}: restart-unhealthy.`,
        );
      }
    },
  );
}
