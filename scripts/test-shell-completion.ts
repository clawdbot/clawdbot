/**
 * Test script for shell completion installation feature.
 *
 * This script simulates the shell completion prompt that appears during
 * `openclaw update`. Use it to verify the completion installation flow
 * without running a full update.
 *
 * Run from repo root:
 *   node --import tsx scripts/test-shell-completion.ts [options]
 *   npx tsx scripts/test-shell-completion.ts [options]
 *   bun scripts/test-shell-completion.ts [options]
 *
 * Options:
 *   --shell <shell>   Override shell detection (zsh, bash, fish, powershell)
 *   --check-only      Only check status, don't prompt to install
 *   --force           Skip the "already installed" check and prompt anyway
 *   --help            Show this help message
 *
 * Examples:
 *   node --import tsx scripts/test-shell-completion.ts
 *   node --import tsx scripts/test-shell-completion.ts --check-only
 *   node --import tsx scripts/test-shell-completion.ts --shell bash
 *   node --import tsx scripts/test-shell-completion.ts --force
 */

import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { confirm, isCancel } from "@clack/prompts";
import { expectDefined } from "../packages/normalization-core/src/expect.js";
import { stylePromptMessage } from "../packages/terminal-core/src/prompt-style.js";
import { theme } from "../packages/terminal-core/src/theme.js";
import {
  COMPLETION_SHELLS,
  installCompletion,
  isCompletionShell,
  resolveCompletionProfilePath,
  type CompletionShell,
} from "../src/cli/completion-runtime.js";
import {
  checkShellCompletionStatus,
  ensureCompletionCacheExists,
} from "../src/commands/doctor-completion.js";

const CLI_NAME = "openclaw";

interface Options {
  checkOnly: boolean;
  force: boolean;
  help: boolean;
  shell?: CompletionShell;
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    checkOnly: false,
    force: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = expectDefined(args[index], `shell completion argument at index ${index}`);
    if (arg === "--check-only") {
      options.checkOnly = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--shell") {
      const value = args[index + 1];
      options.shell = parseShellOptionValue(value);
      index += 1;
    } else if (arg.startsWith("--shell=")) {
      options.shell = parseShellOptionValue(arg.slice("--shell=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function parseShellOptionValue(value: string | undefined): CompletionShell {
  if (!value || value.startsWith("-")) {
    throw new Error("--shell requires a value");
  }
  if (!isCompletionShell(value)) {
    throw new Error(`--shell must be one of: ${COMPLETION_SHELLS.join(", ")}`);
  }
  return value;
}

function printHelp(): void {
  console.log(`
${theme.heading("Shell Completion Test Script")}

This script simulates the shell completion checks that run during
\`openclaw update\`, \`openclaw doctor\`, and \`openclaw onboard\`.

${theme.heading("Usage (run from repo root):")}
  node --import tsx scripts/test-shell-completion.ts [options]
  npx tsx scripts/test-shell-completion.ts [options]
  bun scripts/test-shell-completion.ts [options]

${theme.heading("Options:")}
  --shell <shell>   Override shell detection (zsh, bash, fish, powershell)
  --check-only      Only check status, don't prompt to install
  --force           Skip the "already installed" check and prompt anyway
  --help, -h        Show this help message

${theme.heading("Behavior:")}
  - If profile has completion but no cache: auto-regenerates cache
  - If no completion at all: prompts to install
  - If both profile and cache exist: nothing to do

${theme.heading("Examples:")}
  node --import tsx scripts/test-shell-completion.ts
  node --import tsx scripts/test-shell-completion.ts --check-only
  node --import tsx scripts/test-shell-completion.ts --shell bash
  node --import tsx scripts/test-shell-completion.ts --force
`);
}

async function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.help) {
    printHelp();
    return;
  }

  console.log(theme.heading("Shell Completion Test"));
  console.log("");

  // Get completion status using the same function used by doctor/update/onboard
  const status = await checkShellCompletionStatus(CLI_NAME, { shell: options.shell });
  const shellSource = options.shell ? "(from --shell)" : "(detected from $SHELL)";

  console.log(`  Shell: ${theme.accent(status.shell)} ${theme.muted(shellSource)}`);
  console.log(`  Platform: ${theme.muted(process.platform)} ${theme.muted(`(${os.release()})`)}`);
  console.log(`  Profile: ${theme.muted(resolveCompletionProfilePath(status.shell))}`);
  console.log(`  Cache path: ${theme.muted(status.cachePath)}`);
  console.log("");
  console.log(
    `  Profile configured: ${status.profileInstalled ? theme.success("yes") : theme.warn("no")}`,
  );
  console.log(`  Cache exists: ${status.cacheExists ? theme.success("yes") : theme.warn("no")}`);
  console.log(
    `  Uses slow pattern: ${status.usesSlowPattern ? theme.error("yes (needs upgrade)") : theme.success("no")}`,
  );
  console.log("");

  if (options.checkOnly) {
    console.log(theme.muted("Check-only mode, exiting."));
    return;
  }

  // Profile uses slow dynamic pattern - upgrade to cached version
  if (status.usesSlowPattern) {
    console.log(theme.warn("Profile uses slow dynamic completion. Upgrading to cached version..."));
    const cacheGenerated = await ensureCompletionCacheExists(CLI_NAME, {
      shell: status.shell,
      generationMode: "full",
    });
    if (cacheGenerated) {
      await installCompletion(status.shell, false, CLI_NAME);
      console.log(theme.success("Upgraded to cached completion."));
    } else {
      console.log(theme.error("Failed to generate cache."));
    }
    return;
  }

  // Profile has completion but no cache - auto-fix
  if (status.profileInstalled && !status.cacheExists) {
    console.log(theme.warn("Profile has completion but cache is missing. Regenerating..."));
    const cacheGenerated = await ensureCompletionCacheExists(CLI_NAME, {
      shell: status.shell,
      generationMode: "full",
    });
    if (cacheGenerated) {
      console.log(theme.success("Cache regenerated successfully."));
    } else {
      console.log(theme.error("Failed to regenerate cache."));
    }
    return;
  }

  // Both profile and cache exist - nothing to do
  if (status.profileInstalled && status.cacheExists && !options.force) {
    console.log(theme.muted("Shell completion is fully configured. To test the prompt:"));
    console.log(
      theme.muted("  1. Remove the '# OpenClaw Completion' block from your shell profile"),
    );
    console.log(theme.muted("  2. Re-run this script"));
    console.log(theme.muted("  Or use --force to prompt anyway"));
    console.log("");
    return;
  }

  // No profile configured - prompt to install
  console.log(theme.heading("Shell completion"));

  const shouldInstall = await confirm({
    message: stylePromptMessage(`Enable ${status.shell} shell completion for ${CLI_NAME}?`),
    initialValue: true,
  });

  if (isCancel(shouldInstall) || !shouldInstall) {
    console.log(theme.muted(`Skipped. Run \`openclaw completion --install\` later to enable.`));
    return;
  }

  // Generate cache first (required for fast shell startup)
  if (!status.cacheExists) {
    console.log(theme.muted("Generating completion cache..."));
    const cacheGenerated = await ensureCompletionCacheExists(CLI_NAME, {
      shell: status.shell,
      generationMode: "full",
    });
    if (!cacheGenerated) {
      console.log(theme.error("Failed to generate completion cache."));
      return;
    }
    console.log(theme.success("Cache generated."));
  }

  // Install to shell profile
  await installCompletion(status.shell, false, CLI_NAME);
}

export const testing = {
  parseArgs,
};

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(theme.error(`Error: ${message}`));
    process.exit(1);
  });
}
