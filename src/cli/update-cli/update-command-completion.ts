import fs from "node:fs/promises";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveOsHomeDir } from "../../infra/home-dir.js";
import {
  installationTargetEnv,
  resolveInstallationTarget,
} from "../../infra/installation-target-context.js";
import { ExitError, type RuntimeEnv } from "../../runtime.js";
import { exitCliAfterOutput } from "../one-shot-exit.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import type { UpdateCommandOutcome } from "./update-command-post-update.js";
import { resolveServiceRefreshEnv, resolveUpdateTargetEnv } from "./update-command-service-env.js";

type CompleteUpdateCommand = (
  outcome: UpdateCommandOutcome,
  ownedManagedUpdateEnv?: NodeJS.ProcessEnv,
) => Promise<void>;

/** Prepare before mutation; complete only after updater environment and native cleanup release. */
export async function prepareUpdateCommandCompletion(params: {
  runtime: RuntimeEnv;
  json?: boolean;
  yes?: boolean;
  invocationCwd?: string;
}): Promise<CompleteUpdateCommand> {
  const operatorEnv = resolveServiceRefreshEnv(process.env, params.invocationCwd);
  const triage =
    !params.json && !params.yes && process.stdin.isTTY && process.stdout.isTTY
      ? (await import("../../commands/triage.js")).triageCommand
      : undefined;
  const operatorHome = triage ? resolveOsHomeDir(operatorEnv) : undefined;
  return async (outcome, ownedManagedUpdateEnv) => {
    if (outcome.exitCode !== 0 && triage) {
      try {
        const serviceEnv = ownedManagedUpdateEnv
          ? resolveServiceRefreshEnv(ownedManagedUpdateEnv, params.invocationCwd)
          : undefined;
        const target = resolveInstallationTarget(serviceEnv ?? operatorEnv);
        // The agent needs the operator's executable PATH and Node environment,
        // while installation and service selectors belong to the repaired Gateway.
        const env: NodeJS.ProcessEnv = {
          ...resolveUpdateTargetEnv({ baseEnv: operatorEnv, serviceEnv }),
          ...installationTargetEnv(target),
        };
        delete env.OPENCLAW_UPDATE_IN_PROGRESS;
        // Package replacement can remove the invoking directory. The captured OS
        // home can host the repair agent even when the diagnosed state is inaccessible.
        let cwd = params.invocationCwd;
        if (cwd) {
          try {
            if (!(await fs.stat(cwd)).isDirectory()) {
              cwd = undefined;
            } else {
              await fs.access(cwd, fs.constants.X_OK);
            }
          } catch {
            cwd = undefined;
          }
        }
        await withOwnedManagedUpdateEnv(env, () =>
          triage(params.runtime, {
            recovery: { target, cwd: cwd ?? operatorHome, update: outcome.result },
          }),
        );
      } catch (error) {
        if (!(error instanceof ExitError)) {
          params.runtime.error(`Triage could not start: ${formatErrorMessage(error)}`);
        }
      }
    }
    // A coding agent's own exit must not replace the original update outcome.
    if (outcome.exitCode !== 0 || outcome.result.status === "skipped") {
      exitCliAfterOutput(params.runtime, outcome.exitCode);
    }
  };
}
