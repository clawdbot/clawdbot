// Entry points for the full configure wizard and section-limited runs.
import process from "node:process";
import { formatCliCommand } from "../cli/command-format.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import type { WizardSection } from "./configure.shared.js";
import { CONFIGURE_WIZARD_SECTIONS, parseConfigureWizardSections } from "./configure.shared.js";
import { runConfigureWizard } from "./configure.wizard.js";

/**
 * Non-interactive config subcommands surfaced when the wizard cannot run.
 * Mirrors the real `openclaw config <sub>` surface so the message only ever
 * points users at commands that exist (see `src/cli/config-cli.ts`).
 */
const CONFIGURE_NON_TTY_HINT = [
  "Interactive configuration requires an interactive terminal (TTY).",
  "For non-interactive setup, use these subcommands instead:",
  `  ${formatCliCommand("openclaw config set <path> <value>")}  write a config entry`,
  `  ${formatCliCommand("openclaw config get <path>")}          read a config entry`,
  `  ${formatCliCommand("openclaw config patch")}              apply a JSON patch`,
  `  ${formatCliCommand("openclaw config validate")}           validate configuration`,
].join("\n");

/**
 * Refuses to launch the interactive wizard without a TTY.
 *
 * `interactive` lets callers/tests override the detected terminal state
 * (mirrors the `params.interactive ?? process.stdin.isTTY` pattern used by
 * `src/commands/gateway-readiness.ts`), so the fail-closed path is exercisable
 * without mutating the global `process` streams. Both stdin and stdout must be
 * TTYs: the wizard reads from stdin and renders prompts to stdout, so either
 * being piped means it cannot run correctly.
 *
 * Returns true when the wizard may proceed.
 */
function assertInteractiveConfigureTerminal(runtime: RuntimeEnv, interactive?: boolean): boolean {
  const interactiveTerminal = interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (interactiveTerminal) {
    return true;
  }
  runtime.error(CONFIGURE_NON_TTY_HINT);
  runtime.exit(1);
  return false;
}

async function configureCommand(runtime: RuntimeEnv = defaultRuntime) {
  await runConfigureWizard({ command: "configure" }, runtime);
}

async function configureCommandWithSections(
  sections: WizardSection[],
  runtime: RuntimeEnv = defaultRuntime,
) {
  await runConfigureWizard({ command: "configure", sections }, runtime);
}

/** Parse `--section` input and run the requested configure wizard sections. */
export async function configureCommandFromSectionsArg(
  rawSections: unknown,
  runtime: RuntimeEnv = defaultRuntime,
  options?: { interactive?: boolean },
): Promise<void> {
  const { sections, invalid } = parseConfigureWizardSections(rawSections);
  if (invalid.length > 0) {
    runtime.error(
      `Invalid --section: ${invalid.join(", ")}. Expected one of: ${CONFIGURE_WIZARD_SECTIONS.join(", ")}. Run ${formatCliCommand("openclaw configure")} without --section to use the full wizard.`,
    );
    runtime.exit(1);
    return;
  }

  // Fail closed once at the shared entry: both `openclaw configure` and the
  // no-subcommand `openclaw config` route here, so a single guard keeps them
  // consistent instead of partially entering the wizard on a non-TTY pipe.
  // `options.interactive` lets tests drive the fail-closed path directly
  // instead of mutating global `process` streams.
  if (!assertInteractiveConfigureTerminal(runtime, options?.interactive)) {
    return;
  }

  if (sections.length === 0) {
    await configureCommand(runtime);
    return;
  }

  await configureCommandWithSections(sections as never, runtime);
}
