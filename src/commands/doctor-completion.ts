/** Doctor checks and repair effects for cached shell completion setup. */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { CLI_NAME } from "../cli/cli-name.js";
import {
  completionCacheExists,
  COMPLETION_SKIP_PLUGIN_COMMANDS_ENV,
  findCompletionProfileWriteError,
  formatCompletionReloadCommand,
  installCompletion,
  isCompletionInstalled,
  resolveCompletionCachePath,
  resolveCompletionProfileHint,
  resolveCompletionProfilePath,
  resolveShellFromEnv,
  usesSlowDynamicCompletion,
  type CompletionShell,
} from "../cli/completion-runtime.js";
import type { HealthFinding, HealthRepairEffect } from "../flows/health-checks.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const COMPLETION_CACHE_WRITE_TIMEOUT_MS = 30_000;

type ShellCompletionStatusOptions = {
  shell?: CompletionShell;
};

export type CompletionCacheGenerationOptions = ShellCompletionStatusOptions & {
  generationMode: "core-only" | "full";
};

async function installCompletionForDoctor(
  { shell, cachePath }: ShellCompletionStatus,
  cliName: string,
  action: "installed" | "upgraded",
): Promise<void> {
  try {
    await installCompletion(shell, true, cliName);
    const reloadCommand = formatCompletionReloadCommand(shell, resolveCompletionProfileHint(shell));
    note(
      `Shell completion ${action}. Restart your shell or run: ${reloadCommand}`,
      "Shell completion",
    );
  } catch (err) {
    // Completion is optional, but only profile permission failures are safe to downgrade.
    const writeError = findCompletionProfileWriteError(err);
    if (!writeError) {
      throw err;
    }
    const failedPath = writeError.path ?? resolveCompletionProfilePath(shell);
    const command = formatCompletionReloadCommand(shell, cachePath);
    note(
      `Shell completion could not be ${action} (permission or read-only error at ${failedPath}). For this ${shell} session only, run:\n${command}`,
      "Shell completion",
    );
  }
}

/** Generate the completion cache by spawning the CLI. */
async function generateCompletionCache(
  options: CompletionCacheGenerationOptions,
): Promise<boolean> {
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  if (!root) {
    return false;
  }

  const binPath = path.join(root, "openclaw.mjs");
  const args = [binPath, "completion", "--write-state"];
  if (options.shell) {
    args.push("--shell", options.shell);
  }
  const env = { ...process.env };
  // The mode is explicit so ambient repair state cannot silently change a full user-facing cache.
  if (options.generationMode === "core-only") {
    env[COMPLETION_SKIP_PLUGIN_COMMANDS_ENV] = "1";
  } else {
    delete env[COMPLETION_SKIP_PLUGIN_COMMANDS_ENV];
  }
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env,
    encoding: "utf-8",
    timeout: COMPLETION_CACHE_WRITE_TIMEOUT_MS,
  });

  return result.status === 0;
}

export type ShellCompletionStatus = {
  shell: CompletionShell;
  profileInstalled: boolean;
  cacheExists: boolean;
  cachePath: string;
  /** True if profile uses slow dynamic pattern like `source <(openclaw completion ...)` */
  usesSlowPattern: boolean;
};

/** Check the status of shell completion for the current shell. */
export async function checkShellCompletionStatus(
  binName = "openclaw",
  options: ShellCompletionStatusOptions = {},
): Promise<ShellCompletionStatus> {
  const shell = options.shell ?? resolveShellFromEnv();
  const profileInstalled = await isCompletionInstalled(shell, binName);
  const cacheExists = await completionCacheExists(shell, binName);
  const cachePath = resolveCompletionCachePath(shell, binName);
  const usesSlowPattern = await usesSlowDynamicCompletion(shell, binName);

  return {
    shell,
    profileInstalled,
    cacheExists,
    cachePath,
    usesSlowPattern,
  };
}

/** Converts shell completion status into health findings shown by check flows. */
export function shellCompletionStatusToHealthFindings(
  status: ShellCompletionStatus,
): readonly HealthFinding[] {
  const checkId = "core/doctor/shell-completion";
  const pathLocal = `shellCompletion.${status.shell}`;
  if (status.usesSlowPattern) {
    return [
      {
        checkId,
        severity: "info",
        message: `Your ${status.shell} profile uses slow dynamic completion (source <(...)).`,
        path: pathLocal,
        fixHint: "Run `openclaw doctor --fix` to upgrade to cached completion.",
      },
    ];
  }
  if (status.profileInstalled && !status.cacheExists) {
    return [
      {
        checkId,
        severity: "info",
        message: `Shell completion is configured in your ${status.shell} profile but the cache is missing.`,
        path: pathLocal,
        fixHint: `Run \`openclaw completion --write-state\` or \`openclaw doctor --fix\` to regenerate ${status.cachePath}.`,
      },
    ];
  }
  return [];
}

/** Converts shell completion status into dry-run repair effects for health check reporting. */
export function shellCompletionStatusToRepairEffects(
  status: ShellCompletionStatus,
): readonly HealthRepairEffect[] {
  const effects: HealthRepairEffect[] = [];
  if (status.usesSlowPattern && !status.cacheExists) {
    effects.push({
      kind: "state",
      action: "would-generate-completion-cache",
      target: status.cachePath,
      dryRunSafe: true,
    });
  }
  if (status.usesSlowPattern) {
    effects.push({
      kind: "file",
      action: "would-upgrade-shell-profile-completion",
      target: status.shell,
      dryRunSafe: false,
    });
  } else if (status.profileInstalled && !status.cacheExists) {
    effects.push({
      kind: "state",
      action: "would-regenerate-completion-cache",
      target: status.cachePath,
      dryRunSafe: true,
    });
  }
  return effects;
}

type DoctorCompletionOptions = {
  nonInteractive?: boolean;
};

/**
 * Repairs shell completion setup when doctor runs interactively.
 *
 * Slow dynamic profiles are upgraded to cached completion; configured profiles with a missing
 * cache regenerate it; missing completion prompts unless non-interactive mode is active.
 */
export async function doctorShellCompletion(
  _runtime: RuntimeEnv,
  prompter: DoctorPrompter,
  options: DoctorCompletionOptions = {},
): Promise<void> {
  const status = await checkShellCompletionStatus(CLI_NAME);

  // Slow dynamic completion runs the CLI during shell startup; cache it to keep login shells fast.
  if (status.usesSlowPattern) {
    note(
      `Your ${status.shell} profile uses slow dynamic completion (source <(...)).\nUpgrading to cached completion for faster shell startup...`,
      "Shell completion",
    );

    if (!status.cacheExists) {
      const generated = await generateCompletionCache({ generationMode: "core-only" });
      if (!generated) {
        note(
          `Failed to generate completion cache. Run \`${CLI_NAME} completion --write-state\` manually.`,
          "Shell completion",
        );
        return;
      }
    }

    await installCompletionForDoctor(status, CLI_NAME, "upgraded");
    return;
  }

  if (status.profileInstalled && !status.cacheExists) {
    note(
      `Shell completion is configured in your ${status.shell} profile but the cache is missing.\nRegenerating cache...`,
      "Shell completion",
    );
    const generated = await generateCompletionCache({ generationMode: "core-only" });
    if (generated) {
      note(`Completion cache regenerated at ${status.cachePath}`, "Shell completion");
    } else {
      note(
        `Failed to regenerate completion cache. Run \`${CLI_NAME} completion --write-state\` manually.`,
        "Shell completion",
      );
    }
    return;
  }

  if (!status.profileInstalled) {
    if (options.nonInteractive) {
      return;
    }

    const shouldInstall = await prompter.confirm({
      message: `Enable ${status.shell} shell completion for ${CLI_NAME}?`,
      initialValue: true,
    });

    if (shouldInstall) {
      const generated = await generateCompletionCache({ generationMode: "core-only" });
      if (!generated) {
        note(
          `Failed to generate completion cache. Run \`${CLI_NAME} completion --write-state\` manually.`,
          "Shell completion",
        );
        return;
      }

      await installCompletionForDoctor(status, CLI_NAME, "installed");
    }
  }
}

/** Ensures the shell completion cache exists without prompting during setup/update flows. */
export async function ensureCompletionCacheExists(
  binName: string,
  options: CompletionCacheGenerationOptions,
): Promise<boolean> {
  const shell = options.shell ?? resolveShellFromEnv();
  const cacheExists = await completionCacheExists(shell, binName);

  if (cacheExists) {
    return true;
  }

  return generateCompletionCache(options);
}
