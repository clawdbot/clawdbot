import { readPackageVersion } from "./package-json.js";
// Runs OpenClaw package update checks, package steps, and restart handoff.
import { detectGlobalInstallManagerForRoot } from "./update-global.js";
import { buildUpdateCommandRunner, DEFAULT_TIMEOUT_MS } from "./update-runner-command.js";
import { resolveUpdateDoctorExecutionPolicy } from "./update-runner-doctor.js";
import { runGitUpdate } from "./update-runner-git.js";
import { runGlobalUpdate } from "./update-runner-global.js";
import {
  buildStartDirs,
  findPackageRoot,
  looksLikeGitCheckout,
  normalizeDir,
  pathsReferToSameLocation,
  resolveComparablePath,
  resolveGitRoot,
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
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const candidates = buildStartDirs(opts);
  const pkgRoot = await findPackageRoot(candidates);

  let gitRoot = await resolveGitRoot(runCommand, candidates, timeoutMs);
  if (!gitRoot && pkgRoot) {
    const cwdRoot = normalizeDir(opts.cwd);
    if (
      cwdRoot &&
      (await pathsReferToSameLocation(cwdRoot, pkgRoot)) &&
      (await looksLikeGitCheckout(cwdRoot))
    ) {
      gitRoot = await resolveComparablePath(cwdRoot);
    }
  }
  if (gitRoot && pkgRoot && !(await pathsReferToSameLocation(gitRoot, pkgRoot))) {
    gitRoot = null;
  }
  if (gitRoot && !pkgRoot) {
    return {
      status: "error",
      mode: "unknown",
      root: gitRoot,
      reason: "not-openclaw-root",
      steps: [],
      durationMs: Date.now() - startedAt,
    };
  }
  if (gitRoot && pkgRoot && (await pathsReferToSameLocation(gitRoot, pkgRoot))) {
    return await runGitUpdate({
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
    before: { version: beforeVersion },
    steps: [],
    durationMs: Date.now() - startedAt,
  };
}
