import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  resolveControlUiAssetHealth,
  resolveControlUiDistIndexPathForRoot,
} from "./control-ui-assets.js";
import { readPackageVersion } from "./package-json.js";
import { resolveStableNodePath } from "./stable-node-path.js";
import { DEV_BRANCH, type UpdateChannel } from "./update-channels.js";
import {
  managerInstallArgs,
  managerInstallIgnoreScriptsArgs,
  managerScriptArgs,
  resolveUpdateBuildManager,
} from "./update-package-manager.js";
import { runStep } from "./update-runner-command.js";
import {
  buildUpdateDoctorEnv,
  resolveUpdateDoctorExecutionPolicy,
} from "./update-runner-doctor.js";
import {
  gitCleanCheckArgs,
  resolveBuildEnv,
  resolveInstallEnv,
  shouldInstallWithoutScriptsOnWindows,
} from "./update-runner-git-commands.js";
import { prepareStableGitFetch } from "./update-runner-git-fetch.js";
import { runGitDevPreflight } from "./update-runner-git-preflight.js";
import { rebuildRolledBackGitRuntime } from "./update-runner-git-recovery.js";
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

async function readBuiltGatewayBuildId(gitRoot: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(gitRoot, "dist", "build-info.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const buildId = isRecord(parsed) ? parsed.buildId : undefined;
    return typeof buildId === "string" && buildId.trim() ? buildId.trim() : null;
  } catch {
    return null;
  }
}

function parseRemoteTagNames(stdout: string): string[] {
  return normalizeStringEntries(
    stdout.split("\n").map((line) => {
      const ref = line.trim().split(/\s+/u).at(1) ?? "";
      return ref.startsWith("refs/tags/v") ? ref.slice("refs/tags/".length) : "";
    }),
  );
}

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
      recovery: { serviceRestartSafe: true },
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
  const devTarget = channel === "dev" ? opts.devTarget : undefined;
  const hasDevTarget = devTarget !== undefined;
  const needsCheckoutMain = channel === "dev" && !hasDevTarget && branch !== DEV_BRANCH;
  const steps: UpdateStepResult[] = [];
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
    results: steps,
  });

  let allowGatewayServiceRepair = opts.allowGatewayServiceRepair !== false;
  let allowGatewayActivation = opts.allowGatewayActivation === true;
  let mutationPrepared = false;
  let createdDevBranchDuringUpdate = false;
  let devPreflight: Awaited<ReturnType<typeof runGitDevPreflight>> | undefined;
  let runtimeMutationStarted = false;
  let recovery: UpdateRunResult["recovery"];
  const prepareMutation = async (revision: string) => {
    const preparation = await prepareGitMutation({
      runCommand,
      root: gitRoot,
      revision,
      timeoutMs,
      beforeGitMutation: opts.beforeGitMutation,
    });
    allowGatewayServiceRepair = preparation.allowGatewayServiceRepair ?? allowGatewayServiceRepair;
    allowGatewayActivation = preparation.allowGatewayActivation ?? allowGatewayActivation;
    mutationPrepared = true;
  };
  const buildError = (reason: string, status: "error" | "skipped" = "error"): UpdateRunResult => ({
    status,
    mode: "git",
    root: gitRoot,
    reason,
    before: { sha: beforeSha, version: beforeVersion },
    recovery:
      recovery ??
      (mutationPrepared
        ? { serviceRestartSafe: false, reason: "runtime-verification-failed" }
        : { serviceRestartSafe: true }),
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
    const sourceRestored = await rollback();
    recovery = sourceRestored
      ? { serviceRestartSafe: true }
      : { serviceRestartSafe: false, reason: "source-rollback-failed" };
    if (sourceRestored && runtimeMutationStarted && beforeSha) {
      recovery = await rebuildRolledBackGitRuntime({
        gitRoot,
        expectedSha: beforeSha,
        channel,
        runCommand,
        defaultCommandEnv,
        timeoutMs,
        steps,
      });
    }
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

  // Configured pruneTags must not turn this branch refresh into deletion of operator-local tags.
  // Explicit tag refspecs are excluded from the preliminary refresh and fetched only when selected.
  const fetchAllBranchesArgv = [
    "git",
    "-C",
    gitRoot,
    "fetch",
    "--all",
    "--prune",
    "--no-prune-tags",
    "--no-tags",
  ];
  if (channel === "dev") {
    const fetchFailure = await runRequiredStep("git fetch", fetchAllBranchesArgv, "fetch-failed");
    if (fetchFailure) {
      return fetchFailure;
    }
    devPreflight = await runGitDevPreflight({
      gitRoot,
      devTarget,
      needsCheckoutMain,
      runCommand,
      timeoutMs,
      defaultCommandEnv,
      steps,
      step,
    });
    const preflight = devPreflight;
    if (preflight.status !== "ok") {
      return buildError(preflight.reason, preflight.status);
    }
    await prepareMutation(preflight.selectedSha);
    if (hasDevTarget) {
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
            return upstreamFailure;
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
        if (rebaseStep.exitCode !== 0) {
          await runStep({
            runCommand,
            name: "git rebase --abort",
            argv: ["git", "-C", gitRoot, "rebase", "--abort"],
            cwd: gitRoot,
            timeoutMs,
            results: steps,
          });
          return await rollbackError("rebase-failed");
        }
      }
    }
  } else {
    const stableFetch = await prepareStableGitFetch({
      gitRoot,
      timeoutMs,
      runCommand,
      progress: opts.progress,
      steps,
      fetchAllArgv: fetchAllBranchesArgv,
    });
    if (stableFetch.reason) {
      return buildError(stableFetch.reason);
    }
    let remotes = stableFetch.remotes;
    if (!remotes) {
      const remoteStep = await runStep(
        step("git remote", ["git", "-C", gitRoot, "remote"], gitRoot),
      );
      if (remoteStep.exitCode !== 0) {
        return buildError("fetch-failed");
      }
      remotes = normalizeStringEntries((remoteStep.stdoutTail ?? "").split("\n"));
    }
    const mainRemoteStep = await runStep({
      ...step(
        "git config main remote",
        ["git", "-C", gitRoot, "config", "--get", `branch.${DEV_BRANCH}.remote`],
        gitRoot,
      ),
      runCommand: async (argv, options) => {
        const result = await runCommand(argv, options);
        return result.code === 1 ? { ...result, code: 0 } : result;
      },
    });
    if (mainRemoteStep.exitCode !== 0) {
      return buildError("fetch-failed");
    }
    const configuredMainRemote = mainRemoteStep.stdoutTail?.trim() ?? "";
    const configuredReleaseRemote = configuredMainRemote === "." ? "" : configuredMainRemote;
    const releaseRemote = configuredReleaseRemote
      ? remotes.includes(configuredReleaseRemote)
        ? configuredReleaseRemote
        : null
      : remotes.length === 1
        ? (remotes.at(0) ?? null)
        : remotes.includes("origin")
          ? "origin"
          : null;
    if (!releaseRemote) {
      return buildError(
        !configuredReleaseRemote && remotes.length > 1
          ? "ambiguous-release-remote"
          : "fetch-failed",
      );
    }
    let remoteTagsOutput = "";
    const remoteTagsStep = await runStep({
      ...step(
        `git ls-remote ${releaseRemote} tags`,
        [
          "git",
          "-C",
          gitRoot,
          "ls-remote",
          "--tags",
          "--refs",
          "--sort=-v:refname",
          "--",
          releaseRemote,
          "v*",
        ],
        gitRoot,
      ),
      runCommand: async (argv, options) => {
        const result = await runCommand(argv, options);
        remoteTagsOutput = result.stdout;
        return result;
      },
    });
    if (remoteTagsStep.exitCode !== 0) {
      return buildError("fetch-failed");
    }
    const tag = resolveChannelTag(parseRemoteTagNames(remoteTagsOutput), channel);
    if (!tag) {
      return buildError("no-release-tag");
    }
    // Only the selected release from the main branch's source remote may update the shared tag.
    // Configured pruning must not delete unrelated operator-local tags.
    const tagFetchFailure = await runRequiredStep(
      `git fetch ${releaseRemote} ${tag}`,
      [
        "git",
        "-C",
        gitRoot,
        "fetch",
        "--no-prune",
        "--no-tags",
        "--refmap=",
        "--",
        releaseRemote,
        `+refs/tags/${tag}:refs/tags/${tag}`,
      ],
      "fetch-failed",
    );
    if (tagFetchFailure) {
      return tagFetchFailure;
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
    runCommand,
    gitRoot,
    timeoutMs,
    defaultCommandEnv,
    "require-preferred",
  );
  if (manager.kind === "missing-required") {
    return await rollbackError(manager.reason);
  }
  try {
    const installEnv = await resolveInstallEnv(
      manager.manager,
      manager.env ?? defaultCommandEnv,
      gitRoot,
      runCommand,
      timeoutMs,
    );
    // A failed install can already replace dependencies or run lifecycle scripts.
    // Restore the runtime, not only Git HEAD, after any attempted live install.
    runtimeMutationStarted = true;
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
    if (installStep.exitCode !== 0 && shouldInstallWithoutScriptsOnWindows(manager.manager)) {
      const retryArgv = managerInstallIgnoreScriptsArgs(manager.manager);
      if (retryArgv) {
        installStep = await runStep(
          step("deps install (ignore scripts)", retryArgv, gitRoot, installEnv),
        );
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
        resolveBuildEnv(
          manager.env ?? defaultCommandEnv,
          channel === "dev" ? path.join(gitRoot, ".artifacts", "build-all-cache") : undefined,
        ),
      ),
    );
    if (buildStep.exitCode !== 0) {
      return await rollbackError("build-failed");
    }
    const buildCleanCheck = await runStep(
      step("build clean check", gitCleanCheckArgs(gitRoot), gitRoot),
    );
    if (buildCleanCheck.exitCode !== 0) {
      return await rollbackError("build-failed");
    }
    if (buildCleanCheck.stdoutTail?.trim()) {
      return await rollbackError("build-dirty");
    }
    const builtUiHealth = await resolveControlUiAssetHealth({ root: gitRoot });
    if (builtUiHealth.kind !== "ready") {
      const uiBuildStep = await runStep(
        step(
          "ui:build (build fallback)",
          managerScriptArgs(manager.manager, "ui:build"),
          gitRoot,
          manager.env,
        ),
      );
      if (uiBuildStep.exitCode !== 0) {
        return await rollbackError("ui-build-failed");
      }
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
    if (doctorStep.exitCode !== 0) {
      return await rollbackError("doctor-failed");
    }

    const uiHealth = await resolveControlUiAssetHealth({ root: gitRoot });
    if (uiHealth.kind !== "ready") {
      const repairStep = await runStep({
        runCommand,
        name: "ui:build (post-doctor repair)",
        argv: managerScriptArgs(manager.manager, "ui:build"),
        cwd: gitRoot,
        timeoutMs,
        env: manager.env,
        results: steps,
      });
      if (repairStep.exitCode !== 0) {
        return await rollbackError("ui-build-failed");
      }
      const repairedHealth = await resolveControlUiAssetHealth({ root: gitRoot });
      if (repairedHealth.kind !== "ready") {
        const uiIndexPath =
          repairedHealth.indexPath ?? resolveControlUiDistIndexPathForRoot(gitRoot);
        steps.push({
          name: "ui assets verify",
          command: `verify ${uiIndexPath}`,
          cwd: gitRoot,
          durationMs: 0,
          exitCode: 1,
          stderrTail:
            repairedHealth.kind === "incomplete"
              ? `missing startup asset ${repairedHealth.missingAsset} referenced by ${uiIndexPath}`
              : `missing ${uiIndexPath}`,
        });
        return await rollbackError("ui-assets-missing");
      }
    }

    const afterBuildId = channel === "dev" ? await readBuiltGatewayBuildId(gitRoot) : null;
    const afterShaStep = await runStep(
      step("git rev-parse HEAD (after)", ["git", "-C", gitRoot, "rev-parse", "HEAD"], gitRoot),
    );
    if (afterShaStep.exitCode !== 0) {
      return await rollbackError("head-verification-failed");
    }
    if (
      devTarget?.mode === "tracked" &&
      devPreflight?.status === "ok" &&
      afterShaStep.stdoutTail?.trim() !== devPreflight.selectedSha
    ) {
      return await rollbackError("target-sha-mismatch");
    }
    return {
      status: "ok",
      mode: "git",
      root: gitRoot,
      before: { sha: beforeSha, version: beforeVersion },
      after: {
        sha: afterShaStep.stdoutTail?.trim() ?? null,
        version: await readPackageVersion(gitRoot),
        ...(afterBuildId ? { buildId: afterBuildId } : {}),
        ...(devTarget?.mode === "tracked" ? { upstreamRef: devTarget.upstreamRef } : {}),
      },
      steps,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await manager.cleanup?.();
  }
}
