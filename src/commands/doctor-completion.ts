/** Doctor checks and repair effects for cached shell completion setup. */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveCliName } from "../cli/cli-name.js";
import {
  completionCacheExists,
  formatCompletionReloadCommand,
  installCompletion,
  isCompletionInstalled,
  resolveCompletionCachePath,
  resolveCompletionProfilePath,
  resolveShellFromEnv,
  usesSlowDynamicCompletion,
} from "../cli/completion-runtime.js";
import type { HealthFinding, HealthRepairEffect } from "../flows/health-checks.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

type CompletionShell = "zsh" | "bash" | "fish" | "powershell";

const COMPLETION_CACHE_WRITE_TIMEOUT_MS = 30_000;

function resolveCompletionReloadPath(shell: CompletionShell): string {
  if (shell === "powershell") {
    return resolveCompletionProfilePath("powershell");
  }
  return `~/.${shell === "zsh" ? "zshrc" : shell === "bash" ? "bashrc" : "config/fish/config.fish"}`;
}

function formatCompletionReloadNote(
  shell: CompletionShell,
  action: "installed" | "upgraded",
): string {
  const profilePath = resolveCompletionReloadPath(shell);
  return `Shell completion ${action}. Restart your shell or run: ${formatCompletionReloadCommand(shell, profilePath)}`;
}

/** Generate the completion cache by spawning the CLI. */
async function generateCompletionCache(): Promise<boolean> {
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  if (!root) {
    return false;
  }

  const binPath = path.join(root, "openclaw.mjs");
  const result = spawnSync(process.execPath, [binPath, "completion", "--write-state"], {
    cwd: root,
    env: process.env,
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
): Promise<ShellCompletionStatus> {
  const shell = resolveShellFromEnv() as CompletionShell;
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

export type DoctorCompletionOptions = {
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
  const cliName = resolveCliName();
  const status = await checkShellCompletionStatus(cliName);

  // Slow dynamic completion runs the CLI during shell startup; cache it to keep login shells fast.
  if (status.usesSlowPattern) {
    note(
      `Your ${status.shell} profile uses slow dynamic completion (source <(...)).\nUpgrading to cached completion for faster shell startup...`,
      "Shell completion",
    );

    if (!status.cacheExists) {
      const generated = await generateCompletionCache();
      if (!generated) {
        note(
          `Failed to generate completion cache. Run \`${cliName} completion --write-state\` manually.`,
          "Shell completion",
        );
        return;
      }
    }

    await installCompletion(status.shell, true, cliName);
    note(formatCompletionReloadNote(status.shell, "upgraded"), "Shell completion");
    return;
  }

  if (status.profileInstalled && !status.cacheExists) {
    note(
      `Shell completion is configured in your ${status.shell} profile but the cache is missing.\nRegenerating cache...`,
      "Shell completion",
    );
    const generated = await generateCompletionCache();
    if (generated) {
      note(`Completion cache regenerated at ${status.cachePath}`, "Shell completion");
    } else {
      note(
        `Failed to regenerate completion cache. Run \`${cliName} completion --write-state\` manually.`,
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
      message: `Enable ${status.shell} shell completion for ${cliName}?`,
      initialValue: true,
    });

    if (shouldInstall) {
      const generated = await generateCompletionCache();
      if (!generated) {
        note(
          `Failed to generate completion cache. Run \`${cliName} completion --write-state\` manually.`,
          "Shell completion",
        );
        return;
      }

      await installCompletion(status.shell, true, cliName);
      note(formatCompletionReloadNote(status.shell, "installed"), "Shell completion");
    }
  }
}

/** Ensures the shell completion cache exists without prompting during setup/update flows. */
export async function ensureCompletionCacheExists(binName = "openclaw"): Promise<boolean> {
  const shell = resolveShellFromEnv() as CompletionShell;
  const cacheExists = await completionCacheExists(shell, binName);

  if (cacheExists) {
    return true;
  }

  return generateCompletionCache();
}
