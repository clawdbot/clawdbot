import fs from "node:fs/promises";
import path from "node:path";
import { resolveControlUiAssetHealth } from "./control-ui-assets.js";
import { readPackageVersion } from "./package-json.js";
import { resolveStableNodePath } from "./stable-node-path.js";
import { DEV_BRANCH, type UpdateChannel } from "./update-channels.js";
import { readBuiltGatewayBuildId, verifyGitUpdateRecovery } from "./update-git-runtime.js";
import { runStep } from "./update-runner-command.js";
import {
  buildUpdateDoctorEnv,
  resolveUpdateDoctorExecutionPolicy,
} from "./update-runner-doctor.js";
import { gitCleanCheckArgs } from "./update-runner-git-commands.js";
import { runGitCandidatePreflight } from "./update-runner-git-preflight.js";
import { readCurrentGitUpdateRecovery } from "./update-runner-git-recovery.js";
import { prepareGitRuntimePromotion } from "./update-runner-git-runtime.js";
import {
  prepareGitMutation,
  readBranchName,
  resolveChannelTag,
} from "./update-runner-git-target.js";
import type {
  CommandRunner,
  RunStepOptions,
  UpdateRunResult,
  UpdateRunnerOptions,
  UpdateStepResult,
} from "./update-runner-types.js";

export async function updateGitCheckout(params: {
  opts: UpdateRunnerOptions;
  gitRoot: string;
  runCommand: CommandRunner;
  defaultCommandEnv: NodeJS.ProcessEnv | undefined;
  timeoutMs: number;
  startedAt: number;
}): Promise<UpdateRunResult> {
  const { opts, gitRoot, runCommand, defaultCommandEnv, timeoutMs, startedAt } = params;
  const channel: UpdateChannel = opts.channel ?? "dev";
  if (channel === "extended-stable") {
    return {
      status: "error",
      mode: "git",
      root: gitRoot,
      reason: "unsupported_git_channel",
      recovery: await readCurrentGitUpdateRecovery(gitRoot),
      steps: [],
      durationMs: Date.now() - startedAt,
    };
  }

  const beforeShaResult = await runCommand(["git", "-C", gitRoot, "rev-parse", "HEAD"], {
    cwd: gitRoot,
    timeoutMs,
  });
  const beforeSha = beforeShaResult.stdout.trim() || null;
  const [beforeVersion, beforeBuildId] = await Promise.all([
    readPackageVersion(gitRoot),
    readBuiltGatewayBuildId(gitRoot),
  ]);
  const before = {
    sha: beforeSha,
    version: beforeVersion,
    ...(beforeBuildId ? { buildId: beforeBuildId } : {}),
  };
  const branch = await readBranchName(runCommand, gitRoot, timeoutMs);
  const devTarget = channel === "dev" ? opts.devTarget : undefined;
  const hasDevTarget = devTarget !== undefined;
  const needsCheckoutMain = channel === "dev" && !hasDevTarget && branch !== DEV_BRANCH;
  const totalSteps = channel === "dev" ? (needsCheckoutMain ? 12 : 11) : 9;
  const steps: UpdateStepResult[] = [];
  let stepIndex = 0;
  const step = (
    name: string,
    argv: string[],
    cwd: string,
    env?: NodeJS.ProcessEnv,
  ): RunStepOptions => ({
    runCommand,
    name,
    argv,
    cwd,
    timeoutMs,
    env,
    progress: opts.progress,
    stepIndex: stepIndex++,
    totalSteps,
    results: steps,
  });

  let allowGatewayServiceRepair = opts.allowGatewayServiceRepair !== false;
  let allowGatewayActivation = opts.allowGatewayActivation === true;
  let createdDevBranchDuringUpdate = false;
  let mutationPrepared = false;
  let runtimePromotion: Awaited<ReturnType<typeof prepareGitRuntimePromotion>> | undefined;
  let stateMigrationStarted = false;
  let recovery = await verifyGitUpdateRecovery({ root: gitRoot, sha: beforeSha });
  const prepareMutation = async (revision: string) => {
    const preparation = await prepareGitMutation({
      runCommand,
      root: gitRoot,
      revision,
      timeoutMs,
      beforeGitMutation: opts.beforeGitMutation,
    });
    mutationPrepared = true;
    allowGatewayServiceRepair = preparation.allowGatewayServiceRepair ?? allowGatewayServiceRepair;
    allowGatewayActivation = preparation.allowGatewayActivation ?? allowGatewayActivation;
    recovery = { serviceRestartSafe: false, reason: "runtime-verification-failed" };
  };
  const buildError = (reason: string, status: "error" | "skipped" = "error"): UpdateRunResult => ({
    status,
    mode: "git",
    root: gitRoot,
    reason,
    before,
    recovery,
    steps,
    durationMs: Date.now() - startedAt,
  });
  const appendRecoveryStep = async (name: string, argv: string[]) => {
    const result = await runStep({
      runCommand,
      name,
      argv,
      cwd: gitRoot,
      timeoutMs,
      stepIndex: 0,
      totalSteps: 1,
      results: steps,
    });
    return result.exitCode === 0;
  };
  const verifyRollbackHead = async () => {
    if (!beforeSha) {
      return false;
    }
    const result = await runStep({
      runCommand,
      name: "git rollback verify HEAD",
      argv: ["git", "-C", gitRoot, "rev-parse", "HEAD"],
      cwd: gitRoot,
      timeoutMs,
      stepIndex: 0,
      totalSteps: 1,
      results: steps,
    });
    const verified = result.exitCode === 0 && result.stdoutTail?.trim() === beforeSha;
    result.exitCode = verified ? 0 : 1;
    if (!verified) {
      result.stderrTail = `expected ${beforeSha}, found ${result.stdoutTail?.trim() || "unreadable HEAD"}`;
    }
    return verified;
  };
  const rollback = async () => {
    if (!beforeSha) {
      return false;
    }
    let restored = await appendRecoveryStep("git rollback clean", [
      "git",
      "-C",
      gitRoot,
      "reset",
      "--hard",
    ]);
    // Preflight requires a clean checkout outside generated Control UI assets,
    // so preserve that excluded directory while removing update-created paths.
    restored =
      (await appendRecoveryStep("git rollback clean untracked", [
        "git",
        "-C",
        gitRoot,
        "clean",
        "-fd",
        "-e",
        "dist/control-ui/",
      ])) && restored;
    if (branch && branch !== "HEAD") {
      const checkedOut = await appendRecoveryStep("git rollback checkout", [
        "git",
        "-C",
        gitRoot,
        "checkout",
        "--force",
        branch,
      ]);
      if (checkedOut) {
        restored =
          (await appendRecoveryStep("git rollback reset", [
            "git",
            "-C",
            gitRoot,
            "reset",
            "--hard",
            beforeSha,
          ])) && restored;
        if (createdDevBranchDuringUpdate) {
          await appendRecoveryStep(`git rollback delete ${DEV_BRANCH}`, [
            "git",
            "-C",
            gitRoot,
            "branch",
            "-D",
            DEV_BRANCH,
          ]);
        }
      }
      const verified = await verifyRollbackHead();
      return restored && checkedOut && verified;
    }
    restored =
      (await appendRecoveryStep("git rollback checkout", [
        "git",
        "-C",
        gitRoot,
        "checkout",
        "--detach",
        beforeSha,
      ])) && restored;
    if (createdDevBranchDuringUpdate) {
      await appendRecoveryStep(`git rollback delete ${DEV_BRANCH}`, [
        "git",
        "-C",
        gitRoot,
        "branch",
        "-D",
        DEV_BRANCH,
      ]);
    }
    const verified = await verifyRollbackHead();
    return restored && verified;
  };
  const rollbackError = async (reason: string) => {
    // Doctor can migrate state before failing. Restoring code cannot undo that boundary.
    if (stateMigrationStarted) {
      return buildError(reason);
    }
    const sourceRestored = await rollback();
    let runtimeRestored = true;
    try {
      await runtimePromotion?.restore();
    } catch {
      runtimeRestored = false;
    }
    recovery = !sourceRestored
      ? { serviceRestartSafe: false, reason: "source-rollback-failed" }
      : !runtimeRestored
        ? { serviceRestartSafe: false, reason: "runtime-verification-failed" }
        : await verifyGitUpdateRecovery({ root: gitRoot, sha: beforeSha });
    return buildError(reason);
  };
  const runRequiredStep = async (name: string, argv: string[], reason: string) => {
    const result = await runStep(step(name, argv, gitRoot));
    if (result.exitCode === 0) {
      return null;
    }
    return mutationPrepared ? rollbackError(reason) : buildError(reason);
  };

  const statusCheck = await runStep(step("clean check", gitCleanCheckArgs(gitRoot), gitRoot));
  if (statusCheck.exitCode !== 0) {
    return buildError("clean-check-failed");
  }
  if (statusCheck.stdoutTail?.trim()) {
    return buildError("dirty", "skipped");
  }

  try {
    const fetchFailure = await runRequiredStep(
      "git fetch",
      [
        "git",
        "-C",
        gitRoot,
        "fetch",
        "--all",
        "--prune",
        channel === "dev" ? "--no-tags" : "--tags",
      ],
      "fetch-failed",
    );
    if (fetchFailure) {
      return fetchFailure;
    }
    const tag =
      channel === "dev"
        ? undefined
        : await resolveChannelTag(runCommand, gitRoot, timeoutMs, channel);
    if (channel !== "dev" && !tag) {
      return buildError("no-release-tag");
    }
    const preflight = await runGitCandidatePreflight({
      gitRoot,
      devTarget,
      targetRevision: tag ?? undefined,
      beforeSha,
      needsCheckoutMain,
      runCommand,
      timeoutMs,
      defaultCommandEnv,
      steps,
      step,
      validateCandidate: opts.validateCandidate,
      prepareGitExposure: opts.prepareGitExposure,
      prepareCandidate: async (root, cleanupRoot) => {
        runtimePromotion = await prepareGitRuntimePromotion(
          gitRoot,
          root,
          runCommand,
          timeoutMs,
          cleanupRoot,
        );
      },
    });
    if (preflight.status !== "ok") {
      return buildError(preflight.reason, preflight.status);
    }
    // Candidate validation and worktree cleanup finish while the old gateway serves.
    // Its exact build is retained on this filesystem; activation never installs or builds.
    const currentHead = await runCommand(["git", "-C", gitRoot, "rev-parse", "HEAD"], {
      cwd: gitRoot,
      timeoutMs,
    });
    const currentStatus = await runCommand(gitCleanCheckArgs(gitRoot), { cwd: gitRoot, timeoutMs });
    if (currentHead.code !== 0 || currentStatus.code !== 0) {
      return buildError("clean-check-failed");
    }
    const currentBranch = await readBranchName(runCommand, gitRoot, timeoutMs);
    if (
      currentHead.stdout.trim() !== beforeSha ||
      currentBranch !== branch ||
      currentStatus.stdout.trim()
    ) {
      return buildError("dirty", "skipped");
    }
    await prepareMutation(preflight.candidateSha);
    const activateBranch = channel === "dev" && !hasDevTarget;
    const failure = await runRequiredStep(
      `git checkout ${activateBranch ? DEV_BRANCH : preflight.candidateSha}`,
      activateBranch
        ? ["git", "-C", gitRoot, "checkout", "-B", DEV_BRANCH, preflight.candidateSha]
        : ["git", "-C", gitRoot, "checkout", "--detach", preflight.candidateSha],
      "checkout-failed",
    );
    if (failure) {
      return failure;
    }
    createdDevBranchDuringUpdate = activateBranch && preflight.localDevBranchExists === false;
    if (createdDevBranchDuringUpdate && preflight.selectedDevUpstream) {
      const upstreamFailure = await runRequiredStep(
        `git branch --set-upstream-to ${preflight.selectedDevUpstream} ${DEV_BRANCH}`,
        [
          "git",
          "-C",
          gitRoot,
          "branch",
          "--set-upstream-to",
          preflight.selectedDevUpstream,
          DEV_BRANCH,
        ],
        "checkout-failed",
      );
      if (upstreamFailure) {
        return upstreamFailure;
      }
    }
    if (!runtimePromotion) {
      return await rollbackError("runtime-verification-failed");
    }
    try {
      await runtimePromotion.activate();
    } catch (error) {
      steps.push({
        name: "git runtime activation",
        command: "activate validated runtime",
        cwd: gitRoot,
        durationMs: 0,
        exitCode: 1,
        stderrTail: String(error),
      });
      return await rollbackError("runtime-verification-failed");
    }

    // Source conversion migrates only after its prepared global exposure is swapped.
    if (!opts.prepareGitExposure) {
      const doctorEntry = path.join(gitRoot, "openclaw.mjs");
      const doctorEntryExists = await fs.stat(doctorEntry).then(
        () => true,
        () => false,
      );
      if (!doctorEntryExists) {
        steps.push({
          name: "openclaw doctor entry",
          command: `verify ${doctorEntry}`,
          cwd: gitRoot,
          durationMs: 0,
          exitCode: 1,
          stderrTail: `missing ${doctorEntry}`,
        });
        return await rollbackError("doctor-entry-missing");
      }
      const doctorNodePath = await resolveStableNodePath(process.execPath);
      const doctorTargetVersion = await readPackageVersion(gitRoot);
      const doctorPolicy = resolveUpdateDoctorExecutionPolicy({
        targetVersion: doctorTargetVersion,
        allowGatewayServiceRepair,
      });
      stateMigrationStarted = true;
      recovery = { serviceRestartSafe: false, reason: "state-migration-started" };
      const doctorStep = await runStep(
        step(
          "openclaw doctor",
          [
            doctorNodePath,
            doctorEntry,
            "doctor",
            "--non-interactive",
            ...(doctorPolicy.fix ? ["--fix"] : []),
          ],
          gitRoot,
          buildUpdateDoctorEnv({
            allowGatewayServiceRepair,
            allowGatewayActivation,
            serviceRepairPolicy: doctorPolicy.serviceRepairPolicy,
            deferConfiguredPluginInstallRepair: opts.deferConfiguredPluginInstallRepair,
          }),
        ),
      );
      if (doctorStep.exitCode !== 0) {
        return await rollbackError("doctor-failed");
      }
    }

    if ((await resolveControlUiAssetHealth({ root: gitRoot })).kind !== "ready") {
      steps.push({
        name: "ui assets verify",
        command: "verify startup assets",
        cwd: gitRoot,
        durationMs: 0,
        exitCode: 1,
        stderrTail: "Control UI startup assets are missing or incomplete after Doctor",
      });
      return await rollbackError("ui-assets-missing");
    }
    const afterBuildId = await readBuiltGatewayBuildId(gitRoot);
    const afterShaStep = await runStep(
      step("git rev-parse HEAD (after)", ["git", "-C", gitRoot, "rev-parse", "HEAD"], gitRoot),
    );
    if (afterShaStep.exitCode !== 0) {
      return await rollbackError("head-verification-failed");
    }
    if (afterShaStep.stdoutTail?.trim() !== preflight.candidateSha) {
      return await rollbackError("target-sha-mismatch");
    }
    return {
      status: "ok",
      mode: "git",
      root: gitRoot,
      before,
      after: {
        sha: afterShaStep.stdoutTail?.trim() ?? null,
        version: await readPackageVersion(gitRoot),
        ...(afterBuildId ? { buildId: afterBuildId } : {}),
        ...(devTarget?.mode === "tracked" ? { upstreamRef: devTarget.upstreamRef } : {}),
      },
      steps,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (!mutationPrepared) {
      throw error;
    }
    steps.push({
      name: "git update",
      command: "update checkout",
      cwd: gitRoot,
      durationMs: 0,
      exitCode: 1,
      stderrTail: String(error),
    });
    return await rollbackError("unexpected-error");
  } finally {
    await runtimePromotion?.cleanup();
  }
}
