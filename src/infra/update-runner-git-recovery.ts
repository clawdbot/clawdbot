import fs from "node:fs/promises";
import path from "node:path";
import { resolveControlUiAssetHealth } from "./control-ui-assets.js";
import type { UpdateChannel } from "./update-channels.js";
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

async function readHead(filePath: string, field: "commit" | "head"): Promise<string | null> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    return typeof value[field] === "string" ? value[field] : null;
  } catch {
    return null;
  }
}

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

    const distRoot = path.join(params.gitRoot, "dist");
    const [commit, buildHead, runtimeHead, entryExists, uiHealth] = await Promise.all([
      readHead(path.join(distRoot, "build-info.json"), "commit"),
      readHead(path.join(distRoot, ".buildstamp"), "head"),
      readHead(path.join(distRoot, ".runtime-postbuildstamp"), "head"),
      Promise.any([
        fs.stat(path.join(distRoot, "entry.js")),
        fs.stat(path.join(distRoot, "entry.mjs")),
      ]).then(
        () => true,
        () => false,
      ),
      resolveControlUiAssetHealth({ root: params.gitRoot }),
    ]);
    const verified =
      commit === params.expectedSha &&
      buildHead === params.expectedSha &&
      runtimeHead === params.expectedSha &&
      entryExists &&
      uiHealth.kind === "ready";
    params.steps.push({
      name: "git rollback runtime verify",
      command: `verify rollback runtime ${params.expectedSha}`,
      cwd: params.gitRoot,
      durationMs: 0,
      exitCode: verified ? 0 : 1,
      ...(verified
        ? {}
        : {
            stderrTail: `rollback runtime mismatch (build=${commit ?? "missing"}, buildStamp=${buildHead ?? "missing"}, runtimeStamp=${runtimeHead ?? "missing"}, entry=${entryExists}, ui=${uiHealth.kind})`,
          }),
    });
    return verified
      ? { serviceRestartSafe: true }
      : { serviceRestartSafe: false, reason: "runtime-verification-failed" };
  } finally {
    await manager.cleanup?.();
  }
}
