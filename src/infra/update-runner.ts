// Runs Git checkout updates; package replacement belongs to the update CLI.
import { withForegroundGitMaintenance } from "./git-exec.js";
import { readPackageVersion } from "./package-json.js";
import { verifyPackageUpdateRecovery } from "./update-global.js";
import {
  resolveGitRoot,
  resolveUpdateInstallRoot,
  updateInstallRootsMatch,
} from "./update-install-root.js";
import { buildUpdateCommandRunner, UPDATE_RUNNER_TIMEOUT_MS } from "./update-runner-command.js";
import { resolveUpdateDoctorExecutionPolicy } from "./update-runner-doctor.js";
import { updateGitCheckout } from "./update-runner-git.js";
import {
  buildStartDirs,
  findPackageRoot,
  looksLikeGitCheckout,
  normalizeDir,
  resolveUpdateInstallSurface,
} from "./update-runner-install-surface.js";
import type { UpdateRunResult, UpdateRunnerOptions } from "./update-runner-types.js";

export type {
  UpdateRunResult,
  UpdateStepAdvisory,
  UpdateStepProgress,
  UpdateStepResult,
} from "./update-runner-types.js";
export { resolveUpdateDoctorExecutionPolicy, resolveUpdateInstallSurface };

export async function runGatewayUpdate(opts: UpdateRunnerOptions = {}): Promise<UpdateRunResult> {
  const result = await runGatewayUpdateInternal(opts);
  return opts.runId ? { ...result, runId: opts.runId } : result;
}

async function runGatewayUpdateInternal(opts: UpdateRunnerOptions): Promise<UpdateRunResult> {
  const startedAt = Date.now();
  const { defaultCommandEnv, runCommand } = await buildUpdateCommandRunner(opts.runCommand);
  const timeoutMs = opts.timeoutMs ?? UPDATE_RUNNER_TIMEOUT_MS;
  const candidates = buildStartDirs(opts);
  const pkgRoot = await findPackageRoot(candidates);

  let gitRoot = await resolveGitRoot(runCommand, candidates, timeoutMs, pkgRoot);
  if (!gitRoot && pkgRoot) {
    const cwdRoot = normalizeDir(opts.cwd);
    if (
      cwdRoot &&
      updateInstallRootsMatch(cwdRoot, pkgRoot) &&
      (await looksLikeGitCheckout(cwdRoot))
    ) {
      gitRoot = resolveUpdateInstallRoot(cwdRoot);
    }
  }
  if (gitRoot && !pkgRoot) {
    return {
      status: "error",
      mode: "unknown",
      root: gitRoot,
      reason: "not-openclaw-root",
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      steps: [],
      durationMs: Date.now() - startedAt,
    };
  }
  if (gitRoot && pkgRoot) {
    return await updateGitCheckout({
      opts,
      gitRoot,
      runCommand,
      defaultCommandEnv,
      timeoutMs,
      startedAt,
    });
  }
  if (!pkgRoot) {
    return {
      status: "error",
      mode: "unknown",
      reason: "not-openclaw-root",
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      steps: [],
      durationMs: Date.now() - startedAt,
    };
  }

  const beforeVersion = await readPackageVersion(pkgRoot);
  return {
    status: "skipped",
    mode: "unknown",
    root: pkgRoot,
    reason: "not-git-install",
    recovery: await verifyPackageUpdateRecovery(pkgRoot),
    before: { version: beforeVersion },
    steps: [],
    durationMs: Date.now() - startedAt,
  };
}

export async function runGatewayUpdatePreflight(
  cwd: string | undefined,
  timeoutMs: number | undefined,
  devTarget?: UpdateRunnerOptions["devTarget"],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const { runCommand } = await buildUpdateCommandRunner();
  const complete = new Error("update-preflight-complete");
  const result = await runGatewayUpdate({
    cwd,
    timeoutMs,
    devTarget,
    runCommand: (argv, options) =>
      runCommand(withForegroundGitMaintenance(argv), {
        ...options,
        signal: options.signal ?? signal,
      }),
    beforeGitMutation: () => Promise.reject(complete),
  }).catch((error: unknown) => {
    if (error !== complete) {
      throw error;
    }
  });
  signal?.throwIfAborted();
  return result;
}
