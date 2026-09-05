import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  readUpdateStateSchemaVersions,
  updateStateSchemaVersionsMatch,
} from "../../infra/update-candidate-state.js";
import type { UpdateRunStep } from "../../infra/update-run-record.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { resolveCliName } from "../cli-name.js";
import { resolveNodeRunner } from "./shared.js";
import type { FinishUpdateParams } from "./update-command-post-update.js";
import {
  resolveUpdatedInstallCommandEnv,
  stripGatewayServiceMarkerEnv,
} from "./update-command-service-env.js";
import { maybeResumeWindowsTaskAutoStartAfterPackageUpdate } from "./update-command-service.js";

const CLI_NAME = resolveCliName();

/** Inspect private state copies without reopening migrated state through the previous runtime. */
export async function inspectActivatedUpdateState(
  params: Pick<
    FinishUpdateParams,
    "result" | "root" | "schemaVersions" | "packageUpdateNodeRunner"
  > & {
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    candidateSchemaVersions?: OpenClawSchemaVersions;
  },
): Promise<FinishUpdateParams["rollbackBlockedReason"]> {
  const { result, root, schemaVersions, candidateSchemaVersions, env, config } = params;
  if (!schemaVersions) {
    return undefined;
  }
  try {
    const current = await readUpdateStateSchemaVersions({
      stateDir: resolveStateDir(env),
      config,
      env,
      root: result.root ?? null,
      nodeRunner: params.packageUpdateNodeRunner,
    });
    const sharedVersion = current.find(
      (entry) => entry.path === resolveOpenClawStateSqlitePath(env),
    )?.userVersion;
    if (
      result.status === "ok" &&
      candidateSchemaVersions &&
      sharedVersion !== candidateSchemaVersions.state
    ) {
      // Doctor can warn without failing. Startup must not perform a late
      // migration underneath the previous runtime's ledger writer.
      result.status = "error";
      result.reason = `${CLI_NAME} doctor`;
      result.steps.push({
        name: `${CLI_NAME} doctor`,
        command: `${CLI_NAME} doctor --fix`,
        cwd: result.root ?? root,
        durationMs: 0,
        exitCode: 1,
        stderrTail: `Shared state migration did not finish: expected schema ${candidateSchemaVersions.state}, found ${sharedVersion ?? "missing"}.`,
      });
    }
    return updateStateSchemaVersionsMatch(schemaVersions, current)
      ? undefined
      : "state-migrated-no-rollback";
  } catch (error) {
    result.status = "error";
    result.reason = "rollback-state-unverified";
    result.steps.push({
      name: "state schema verification",
      command: "openclaw update",
      cwd: result.root ?? root,
      durationMs: 0,
      exitCode: 1,
      stderrTail: formatErrorMessage(error),
    });
    return "rollback-state-unverified";
  }
}

export type MigratedUpdateFinalizationInput = {
  params: Omit<FinishUpdateParams, "packageTransaction" | "preManagedServiceStop"> & {
    preManagedServiceStop?: Omit<
      NonNullable<FinishUpdateParams["preManagedServiceStop"]>,
      "windowsTaskAutoStartRecovery"
    >;
  };
  bufferedSteps: UpdateRunStep[];
  resultPath: string;
};

export type MigratedUpdateFinalizationResult = {
  result: UpdateRunResult;
  exitCode: number;
  terminalRunId: string;
};

/** After migration, only candidate code may reopen state or finish the run. */
export async function continueMigratedUpdateInFreshProcess(
  params: FinishUpdateParams,
  bufferedSteps: UpdateRunStep[],
): Promise<{ result: UpdateRunResult; exitCode: number }> {
  const run = params.opts.run;
  if (!run) {
    throw new Error("Migrated update continuation requires its admitted run.");
  }
  const windowsRecovery = params.preManagedServiceStop?.windowsTaskAutoStartRecovery;
  let result = params.result;
  try {
    if (result.status === "ok") {
      await maybeResumeWindowsTaskAutoStartAfterPackageUpdate(params.preManagedServiceStop, true);
    } else {
      await windowsRecovery?.complete(false);
    }
  } catch (error) {
    await windowsRecovery?.complete(false);
    // Compensation still belongs to the parent closure, but only candidate
    // code can persist its failure after migration.
    result = {
      ...result,
      status: "error",
      reason: "windows-task-autostart-restore-failed",
      steps: [
        ...result.steps,
        {
          name: "Windows task autostart restoration",
          command: "openclaw update",
          cwd: result.root ?? params.root,
          durationMs: 0,
          exitCode: 1,
          stderrTail: formatErrorMessage(error),
        },
      ],
    };
  }
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-migrated-"));
  try {
    const root = result.root;
    if (!root) {
      throw new Error("The active installation root is unknown; candidate finalization is unsafe.");
    }
    const { packageTransaction: _transaction, preManagedServiceStop, ...serializable } = params;
    let stopState: MigratedUpdateFinalizationInput["params"]["preManagedServiceStop"];
    if (preManagedServiceStop) {
      const { windowsTaskAutoStartRecovery: _windows, ...serializableStop } = preManagedServiceStop;
      stopState = serializableStop;
    }
    const resultPath = path.join(scratchDir, "result.json");
    const input: MigratedUpdateFinalizationInput = {
      params: {
        ...serializable,
        result,
        rollbackBlockedReason: params.rollbackBlockedReason ?? "state-migrated-no-rollback",
        ...(preManagedServiceStop ? { preManagedServiceStop: stopState } : {}),
      },
      bufferedSteps,
      resultPath,
    };
    const child = await runUtf8CommandWithTimeout(
      [
        params.packageUpdateNodeRunner ?? resolveNodeRunner(),
        path.join(root, "dist", runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath),
      ],
      {
        cwd: root,
        baseEnv: {},
        env: {
          ...stripGatewayServiceMarkerEnv(
            resolveUpdatedInstallCommandEnv({
              processEnv: params.ownedManagedUpdateEnv ?? run.env,
            }),
          ),
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          TMPDIR: scratchDir,
          TMP: scratchDir,
          TEMP: scratchDir,
        },
        input: JSON.stringify(input),
        // This continuation includes bounded plugin steps as well as service
        // verification; the whole-process bound must exceed one step's budget.
        timeoutMs: Math.max(30 * 60_000, params.updateStepTimeoutMs * 6),
        killProcessTree: true,
        killGraceMs: 500,
        maxOutputBytes: 1024 * 1024,
      },
    );
    if (child.stdout) {
      process.stdout.write(child.stdout);
    }
    if (child.stderr) {
      process.stderr.write(child.stderr);
    }
    const response = JSON.parse(
      await fs.readFile(resultPath, "utf8"),
    ) as MigratedUpdateFinalizationResult; // SAFETY: Only the candidate worker launched above writes this private artifact.
    if (
      child.termination !== "exit" ||
      child.code !== 0 ||
      response.terminalRunId !== run.runId ||
      response.result.runId !== run.runId ||
      !Number.isInteger(response.exitCode)
    ) {
      throw new Error(
        "Candidate finalization did not confirm the admitted run's terminal outcome.",
      );
    }
    if (response.result.status !== "ok") {
      await windowsRecovery?.complete(false);
    }
    await params.packageTransaction?.complete().catch((error: unknown) => {
      defaultRuntime.error(`Update backup cleanup failed: ${String(error)}`);
    });
    return { result: response.result, exitCode: response.exitCode };
  } catch (error) {
    await windowsRecovery?.complete(false);
    throw error;
  } finally {
    await fs.rm(scratchDir, { recursive: true, force: true });
  }
}
