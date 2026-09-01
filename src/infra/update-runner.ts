import { readPackageVersion } from "./package-json.js";
// Runs OpenClaw package update checks, package steps, and restart handoff.
import { detectGlobalInstallManagerForRoot } from "./update-global.js";
import {
  resolveGitRoot,
  resolveUpdateInstallRoot,
  updateInstallRootsMatch,
} from "./update-install-root.js";
import { buildUpdateCommandRunner, UPDATE_RUNNER_TIMEOUT_MS } from "./update-runner-command.js";
import { resolveUpdateDoctorExecutionPolicy } from "./update-runner-doctor.js";
import { updateGitCheckout } from "./update-runner-git.js";
import { runGlobalUpdate } from "./update-runner-global.js";
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
  UpdateStepInfo,
  UpdateStepProgress,
  UpdateStepResult,
} from "./update-runner-types.js";
export { resolveUpdateDoctorExecutionPolicy, resolveUpdateInstallSurface };

export async function runGatewayUpdate(opts: UpdateRunnerOptions = {}): Promise<UpdateRunResult> {
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
      recovery: { serviceRestartSafe: true },
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
      recovery: { serviceRestartSafe: true },
      steps: [],
      durationMs: Date.now() - startedAt,
    };
  }

  const beforeVersion = await readPackageVersion(pkgRoot);
  const globalManager = await detectGlobalInstallManagerForRoot(runCommand, pkgRoot, timeoutMs);
  if (globalManager) {
    return await runGlobalUpdate({
      opts,
      pkgRoot,
      globalManager,
      runCommand,
      timeoutMs,
      startedAt,
      beforeVersion,
      allowGatewayServiceRepair: opts.allowGatewayServiceRepair !== false,
      allowGatewayActivation: opts.allowGatewayActivation === true,
    });
  }
  return {
    status: "skipped",
    mode: "unknown",
    root: pkgRoot,
    reason: "not-git-install",
    recovery: { serviceRestartSafe: true },
    before: { version: beforeVersion },
    steps: [],
    durationMs: Date.now() - startedAt,
  };
}

export function runGatewayUpdatePreflight(
  cwd: string | undefined,
  timeoutMs: number | undefined,
  devTarget?: UpdateRunnerOptions["devTarget"],
) {
  const complete = new Error("update-preflight-complete");
  return runGatewayUpdate({
    cwd,
    timeoutMs,
    devTarget,
    beforeGitMutation: () => Promise.reject(complete),
  }).catch((error: unknown) => {
    if (error !== complete) {
      throw error;
    }
  });
}
