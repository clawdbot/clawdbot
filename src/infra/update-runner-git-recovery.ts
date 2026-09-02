import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import type { UpdateChannel } from "./update-channels.js";
import { verifyGitUpdateRecovery } from "./update-git-runtime.js";
import {
  managerInstallArgs,
  managerInstallIgnoreScriptsArgs,
  managerScriptArgs,
  resolveUpdateBuildManager,
} from "./update-package-manager.js";
import type { UpdateRecovery } from "./update-recovery.js";
import { runStep } from "./update-runner-command.js";
import {
  resolveBuildEnv,
  resolveInstallEnv,
  gitCleanCheckArgs,
  shouldInstallWithoutScriptsOnWindows,
} from "./update-runner-git-commands.js";
import type { CommandRunner, UpdateStepResult } from "./update-runner-types.js";

export async function rebuildRolledBackGitRuntime(params: {
  gitRoot: string;
  expectedSha: string;
  channel: UpdateChannel;
  runCommand: CommandRunner;
  defaultCommandEnv: NodeJS.ProcessEnv | undefined;
  timeoutMs: number;
  steps: UpdateStepResult[];
}): Promise<UpdateRecovery> {
  const appendStep = async (name: string, argv: string[], env?: NodeJS.ProcessEnv) => {
    const result = await runStep({
      runCommand: params.runCommand,
      name,
      argv,
      cwd: params.gitRoot,
      timeoutMs: params.timeoutMs,
      env,
      stepIndex: 0,
      totalSteps: 1,
      results: params.steps,
    });
    return result.exitCode === 0;
  };
  const appendFailure = (
    reason: Extract<UpdateRecovery, { serviceRestartSafe: false }>["reason"],
    detail: string,
  ): UpdateRecovery => {
    params.steps.push({
      name: "git rollback runtime verify",
      command: `verify rollback runtime ${params.expectedSha}`,
      cwd: params.gitRoot,
      durationMs: 0,
      exitCode: 1,
      stderrTail: detail,
    });
    return { serviceRestartSafe: false, reason };
  };

  const manager = await resolveUpdateBuildManager(
    params.runCommand,
    params.gitRoot,
    params.timeoutMs,
    params.defaultCommandEnv,
    "require-preferred",
  );
  if (manager.kind === "missing-required") {
    return appendFailure("manager-unavailable", manager.reason);
  }
  try {
    const installEnv = await resolveInstallEnv(
      manager.manager,
      manager.env ?? params.defaultCommandEnv,
      params.gitRoot,
      params.runCommand,
      params.timeoutMs,
    );
    let installed = await appendStep(
      "git rollback deps install",
      managerInstallArgs(manager.manager, {
        compatFallback: manager.fallback && manager.manager === "npm",
      }),
      installEnv,
    );
    if (!installed && shouldInstallWithoutScriptsOnWindows(manager.manager)) {
      const retryArgv = managerInstallIgnoreScriptsArgs(manager.manager);
      installed = retryArgv
        ? await appendStep("git rollback deps install (ignore scripts)", retryArgv, installEnv)
        : false;
    }
    if (!installed) {
      return appendFailure("deps-install-failed", "failed to restore dependencies");
    }
    const built = await appendStep(
      "git rollback build",
      managerScriptArgs(manager.manager, "build"),
      resolveBuildEnv(
        manager.env ?? params.defaultCommandEnv,
        params.channel === "dev"
          ? path.join(params.gitRoot, ".artifacts", "build-all-cache")
          : undefined,
      ),
    );
    if (!built) {
      return appendFailure("build-failed", "failed to rebuild the original checkout");
    }

    const cleanCheck = await runStep({
      runCommand: params.runCommand,
      name: "git rollback build clean check",
      argv: gitCleanCheckArgs(params.gitRoot),
      cwd: params.gitRoot,
      timeoutMs: params.timeoutMs,
      stepIndex: 0,
      totalSteps: 1,
      results: params.steps,
    });
    if (cleanCheck.exitCode !== 0) {
      return appendFailure(
        "runtime-verification-failed",
        "failed to verify rollback checkout cleanliness",
      );
    }
    if (cleanCheck.stdoutTail?.trim()) {
      return appendFailure(
        "rollback-checkout-dirty",
        `rollback build left checkout dirty: ${cleanCheck.stdoutTail.trim()}`,
      );
    }

    const recovery = await verifyGitUpdateRecovery({
      root: params.gitRoot,
      sha: params.expectedSha,
    });
    params.steps.push({
      name: "git rollback runtime verify",
      command: `verify rollback runtime ${params.expectedSha}`,
      cwd: params.gitRoot,
      durationMs: 0,
      exitCode: recovery.serviceRestartSafe ? 0 : 1,
      ...(!recovery.serviceRestartSafe
        ? {
            stderrTail:
              "Restored runtime artifacts or Gateway build identity could not be verified.",
          }
        : {}),
    });
    return recovery;
  } finally {
    await manager.cleanup?.();
  }
}

export async function readCurrentGitUpdateRecovery(root: string): Promise<UpdateRecovery> {
  const head = await runCommandWithTimeout(["git", "-C", root, "rev-parse", "HEAD"], {
    cwd: root,
    timeoutMs: 5000,
  }).catch(() => null);
  return verifyGitUpdateRecovery({ root, sha: head?.code === 0 ? head.stdout.trim() : null });
}
