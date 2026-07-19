import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveControlUiDistIndexHealth,
  resolveControlUiDistIndexPathForRoot,
} from "./control-ui-assets.js";
import { readPackageVersion } from "./package-json.js";
import { trimLogTail } from "./restart-sentinel.js";
import { resolveStableNodePath } from "./stable-node-path.js";
import { DEV_BRANCH, type UpdateChannel } from "./update-channels.js";
import {
  managerInstallArgs,
  managerScriptArgs,
  resolveUpdateBuildManager,
} from "./update-package-manager.js";
import { MAX_LOG_CHARS, normalizeFallbackFailureReason, runStep } from "./update-runner-command.js";
import {
  buildUpdateDoctorEnv,
  resolveUpdateDoctorExecutionPolicy,
} from "./update-runner-doctor.js";
import {
  findBlockingGitFailure,
  mapManagerResolutionFailure,
  resolveBuildEnv,
  resolveInstallEnv,
  resolveRetryInstallArgs,
  shouldRetryWindowsInstallIgnoringScripts,
} from "./update-runner-git-commands.js";
import { runGitDevPreflight } from "./update-runner-git-preflight.js";
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

export async function runGitUpdate(params: {
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
      steps: [],
      durationMs: Date.now() - startedAt,
    };
  }

  const beforeShaResult = await runCommand(["git", "-C", gitRoot, "rev-parse", "HEAD"], {
    cwd: gitRoot,
    timeoutMs,
  });
  const beforeSha = beforeShaResult.stdout.trim() || null;
  const beforeVersion = await readPackageVersion(gitRoot);
  const branch = await readBranchName(runCommand, gitRoot, timeoutMs);
  const hasDevTargetRef = channel === "dev" && Boolean(opts.devTargetRef?.trim());
  const needsCheckoutMain = channel === "dev" && !hasDevTargetRef && branch !== DEV_BRANCH;
  const totalSteps = channel === "dev" ? (needsCheckoutMain ? 11 : 10) : 9;
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
  });

  let allowGatewayServiceRepair = opts.allowGatewayServiceRepair !== false;
  let allowGatewayActivation = opts.allowGatewayActivation === true;
  let mutationPrepared = false;
  let createdDevBranchDuringUpdate = false;
  const prepareMutation = async (revision: string) => {
    if (mutationPrepared) {
      return;
    }
    const preparation = await prepareGitMutation({
      runCommand,
      root: gitRoot,
      revision,
      timeoutMs,
      beforeGitMutation: opts.beforeGitMutation,
    });
    if (typeof preparation.allowGatewayServiceRepair === "boolean") {
      allowGatewayServiceRepair = preparation.allowGatewayServiceRepair;
    }
    if (typeof preparation.allowGatewayActivation === "boolean") {
      allowGatewayActivation = preparation.allowGatewayActivation;
    }
    mutationPrepared = true;
  };
  const buildError = (reason: string, status: "error" | "skipped" = "error"): UpdateRunResult => ({
    status,
    mode: "git",
    root: gitRoot,
    reason,
    before: { sha: beforeSha, version: beforeVersion },
    steps,
    durationMs: Date.now() - startedAt,
  });
  const runRequiredStep = async (name: string, argv: string[], reason: string) => {
    const result = await runStep(step(name, argv, gitRoot));
    steps.push(result);
    return result.exitCode === 0 ? null : buildError(reason);
  };
  const appendRecoveryStep = async (name: string, argv: string[]) => {
    const started = Date.now();
    const result = await runCommand(argv, { cwd: gitRoot, timeoutMs });
    steps.push({
      name,
      command: argv.join(" "),
      cwd: gitRoot,
      durationMs: Date.now() - started,
      exitCode: result.code,
      stdoutTail: trimLogTail(result.stdout, MAX_LOG_CHARS),
      stderrTail: trimLogTail(result.stderr, MAX_LOG_CHARS),
    });
    return result.code === 0;
  };
  const rollback = async () => {
    if (!beforeSha) {
      return;
    }
    await appendRecoveryStep("git rollback clean", ["git", "-C", gitRoot, "reset", "--hard"]);
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
        await appendRecoveryStep("git rollback reset", [
          "git",
          "-C",
          gitRoot,
          "reset",
          "--hard",
          beforeSha,
        ]);
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
      return;
    }
    await appendRecoveryStep("git rollback checkout", [
      "git",
      "-C",
      gitRoot,
      "checkout",
      "--detach",
      beforeSha,
    ]);
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
  };
  const rollbackError = async (reason: string) => {
    await rollback();
    return buildError(reason);
  };

  const statusCheck = await runStep(
    step(
      "clean check",
      ["git", "-C", gitRoot, "status", "--porcelain", "--", ":!dist/control-ui/"],
      gitRoot,
    ),
  );
  steps.push(statusCheck);
  if (statusCheck.stdoutTail?.trim()) {
    return buildError("dirty", "skipped");
  }

  if (channel === "dev") {
    const fetchFailure = await runRequiredStep(
      "git fetch",
      ["git", "-C", gitRoot, "fetch", "--all", "--prune", "--no-tags"],
      "fetch-failed",
    );
    if (fetchFailure) {
      return fetchFailure;
    }
    const preflight = await runGitDevPreflight({
      gitRoot,
      devTargetRef: opts.devTargetRef,
      needsCheckoutMain,
      runCommand,
      timeoutMs,
      defaultCommandEnv,
      steps,
      step,
    });
    if (preflight.status !== "ok") {
      return buildError(preflight.reason, preflight.status);
    }
    await prepareMutation(preflight.selectedSha);
    if (hasDevTargetRef) {
      const failure = await runRequiredStep(
        `git checkout ${preflight.selectedSha}`,
        ["git", "-C", gitRoot, "checkout", "--detach", preflight.selectedSha],
        "checkout-failed",
      );
      if (failure) {
        return failure;
      }
    } else {
      let createdAtSelectedSha = false;
      if (needsCheckoutMain) {
        const hasLocalMain = preflight.localDevBranchExists !== false;
        const failure = await runRequiredStep(
          hasLocalMain
            ? `git checkout ${DEV_BRANCH}`
            : `git checkout -B ${DEV_BRANCH} ${preflight.selectedSha}`,
          hasLocalMain
            ? ["git", "-C", gitRoot, "checkout", DEV_BRANCH]
            : ["git", "-C", gitRoot, "checkout", "-B", DEV_BRANCH, preflight.selectedSha],
          "checkout-failed",
        );
        if (failure) {
          return failure;
        }
        createdAtSelectedSha = !hasLocalMain;
        createdDevBranchDuringUpdate = createdAtSelectedSha;
        if (createdAtSelectedSha && preflight.selectedDevUpstream) {
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
            return await rollbackError("checkout-failed");
          }
        }
      }
      if (createdAtSelectedSha) {
        steps.push({
          name: "git rebase",
          command: `git rebase ${preflight.selectedSha}`,
          cwd: gitRoot,
          durationMs: 0,
          exitCode: 0,
          stdoutTail: `skipped; ${DEV_BRANCH} was created at selected preflight SHA`,
        });
      } else {
        const rebaseStep = await runStep(
          step("git rebase", ["git", "-C", gitRoot, "rebase", preflight.selectedSha], gitRoot),
        );
        steps.push(rebaseStep);
        if (rebaseStep.exitCode !== 0) {
          const abort = await runCommand(["git", "-C", gitRoot, "rebase", "--abort"], {
            cwd: gitRoot,
            timeoutMs,
          });
          steps.push({
            name: "git rebase --abort",
            command: "git rebase --abort",
            cwd: gitRoot,
            durationMs: 0,
            exitCode: abort.code,
            stdoutTail: trimLogTail(abort.stdout, MAX_LOG_CHARS),
            stderrTail: trimLogTail(abort.stderr, MAX_LOG_CHARS),
          });
          return buildError("rebase-failed");
        }
      }
    }
  } else {
    const fetchFailure = await runRequiredStep(
      "git fetch",
      ["git", "-C", gitRoot, "fetch", "--all", "--prune", "--tags"],
      "fetch-failed",
    );
    if (fetchFailure) {
      return fetchFailure;
    }
    const tag = await resolveChannelTag(runCommand, gitRoot, timeoutMs, channel);
    if (!tag) {
      return buildError("no-release-tag");
    }
    await prepareMutation(tag);
    const failure = await runRequiredStep(
      `git checkout ${tag}`,
      ["git", "-C", gitRoot, "checkout", "--detach", tag],
      "checkout-failed",
    );
    if (failure) {
      return failure;
    }
  }

  const manager = await resolveUpdateBuildManager(
    (argv, options) => runCommand(argv, { timeoutMs: options.timeoutMs, env: options.env }),
    gitRoot,
    timeoutMs,
    defaultCommandEnv,
    "require-preferred",
  );
  if (manager.kind === "missing-required") {
    return await rollbackError(mapManagerResolutionFailure(manager.reason));
  }
  try {
    const installEnv = resolveInstallEnv(manager.manager, manager.env);
    let installStep = await runStep(
      step(
        "deps install",
        managerInstallArgs(manager.manager, {
          compatFallback: manager.fallback && manager.manager === "npm",
        }),
        gitRoot,
        installEnv,
      ),
    );
    steps.push(installStep);
    if (installStep.exitCode !== 0 && shouldRetryWindowsInstallIgnoringScripts(manager.manager)) {
      const retryArgv = resolveRetryInstallArgs(manager.manager);
      if (retryArgv) {
        installStep = await runStep(
          step("deps install (ignore scripts)", retryArgv, gitRoot, installEnv),
        );
        steps.push(installStep);
      }
    }
    if (installStep.exitCode !== 0) {
      return await rollbackError("deps-install-failed");
    }
    const buildStep = await runStep(
      step(
        "build",
        managerScriptArgs(manager.manager, "build"),
        gitRoot,
        resolveBuildEnv(manager.env),
      ),
    );
    steps.push(buildStep);
    if (buildStep.exitCode !== 0) {
      return await rollbackError("build-failed");
    }
    const uiBuildStep = await runStep(
      step("ui:build", managerScriptArgs(manager.manager, "ui:build"), gitRoot, manager.env),
    );
    steps.push(uiBuildStep);
    if (uiBuildStep.exitCode !== 0) {
      return await rollbackError("ui-build-failed");
    }

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
    steps.push(doctorStep);
    if (doctorStep.exitCode !== 0) {
      return await rollbackError("doctor-failed");
    }

    const uiIndexHealth = await resolveControlUiDistIndexHealth({ root: gitRoot });
    if (!uiIndexHealth.exists) {
      const repairArgv = managerScriptArgs(manager.manager, "ui:build");
      const repairStarted = Date.now();
      const repairResult = await runCommand(repairArgv, {
        cwd: gitRoot,
        timeoutMs,
        env: manager.env,
      });
      steps.push({
        name: "ui:build (post-doctor repair)",
        command: repairArgv.join(" "),
        cwd: gitRoot,
        durationMs: Date.now() - repairStarted,
        exitCode: repairResult.code,
        stdoutTail: trimLogTail(repairResult.stdout, MAX_LOG_CHARS),
        stderrTail: trimLogTail(repairResult.stderr, MAX_LOG_CHARS),
      });
      if (repairResult.code !== 0) {
        return await rollbackError("ui-build-failed");
      }
      const repairedHealth = await resolveControlUiDistIndexHealth({ root: gitRoot });
      if (!repairedHealth.exists) {
        const uiIndexPath =
          repairedHealth.indexPath ?? resolveControlUiDistIndexPathForRoot(gitRoot);
        steps.push({
          name: "ui assets verify",
          command: `verify ${uiIndexPath}`,
          cwd: gitRoot,
          durationMs: 0,
          exitCode: 1,
          stderrTail: `missing ${uiIndexPath}`,
        });
        return await rollbackError("ui-assets-missing");
      }
    }

    const failedStep = findBlockingGitFailure(steps);
    const afterShaStep = await runStep(
      step("git rev-parse HEAD (after)", ["git", "-C", gitRoot, "rev-parse", "HEAD"], gitRoot),
    );
    steps.push(afterShaStep);
    return {
      status: failedStep ? "error" : "ok",
      mode: "git",
      root: gitRoot,
      reason: failedStep ? normalizeFallbackFailureReason(failedStep.name) : undefined,
      before: { sha: beforeSha, version: beforeVersion },
      after: {
        sha: afterShaStep.stdoutTail?.trim() ?? null,
        version: await readPackageVersion(gitRoot),
      },
      steps,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await manager.cleanup?.();
  }
}
