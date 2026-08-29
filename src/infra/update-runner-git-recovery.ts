import path from "node:path";
import type { UpdateChannel } from "./update-channels.js";
import { collectGitRuntimeErrors } from "./update-git-runtime.js";
import {
  managerInstallArgs,
  managerInstallIgnoreScriptsArgs,
  managerScriptArgs,
  resolveUpdateBuildManager,
} from "./update-package-manager.js";
import { runStep } from "./update-runner-command.js";
import {
  resolveBuildEnv,
  resolveInstallEnv,
  shouldInstallWithoutScriptsOnWindows,
} from "./update-runner-git-commands.js";
import type { CommandRunner, UpdateStepResult } from "./update-runner-types.js";

type RecoveryReason =
  | "manager-unavailable"
  | "deps-install-failed"
  | "build-failed"
  | "runtime-verification-failed";

type GitRuntimeRecovery =
  | { serviceRestartSafe: true }
  | { serviceRestartSafe: false; reason: RecoveryReason };

export async function rebuildRolledBackGitRuntime(params: {
  gitRoot: string;
  expectedSha: string;
  channel: UpdateChannel;
  runCommand: CommandRunner;
  defaultCommandEnv: NodeJS.ProcessEnv | undefined;
  timeoutMs: number;
  steps: UpdateStepResult[];
}): Promise<GitRuntimeRecovery> {
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
  const appendFailure = (reason: RecoveryReason, detail: string): GitRuntimeRecovery => {
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

    const runtimeErrors = await collectGitRuntimeErrors({
      root: params.gitRoot,
      sha: params.expectedSha,
    });
    const verified = runtimeErrors.length === 0;
    params.steps.push({
      name: "git rollback runtime verify",
      command: `verify rollback runtime ${params.expectedSha}`,
      cwd: params.gitRoot,
      durationMs: 0,
      exitCode: verified ? 0 : 1,
      ...(verified
        ? {}
        : {
            stderrTail: runtimeErrors.join("\n"),
          }),
    });
    return verified
      ? { serviceRestartSafe: true }
      : { serviceRestartSafe: false, reason: "runtime-verification-failed" };
  } finally {
    await manager.cleanup?.();
  }
}
