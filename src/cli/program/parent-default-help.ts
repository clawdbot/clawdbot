import type { Command } from "commander";

/**
 * Wire a parent command so that invoking it without a subcommand prints the
 * parent's own help and exits with status `0`.
 *
 * Commander's default behavior for a parent with subcommands is to print help
 * and set `process.exitCode = 1`, which differs from `<parent> --help` (which
 * exits 0). That asymmetry breaks shell `&&` chains and surfaces a misleading
 * `ELIFECYCLE Command failed with exit code 1.` line for users running through
 * pnpm. See #73077.
 *
 * Apply this helper only to parent commands that do not have their own default
 * action. Commander does not expose a public "has action handler" API, so
 * callers keep that ownership explicit instead of probing private internals.
 */
export function applyParentDefaultHelpAction(parent: Command): void {
  parent.action(() => {
    parent.outputHelp();
    process.exitCode = 0;
  });
}
