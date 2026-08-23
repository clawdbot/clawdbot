// Shared lifecycle handling for interactive onboarding entrypoints.
import { restoreTerminalState } from "../../packages/terminal-core/src/restore.js";
import type { RuntimeEnv } from "../runtime.js";
import { WizardCancelledError } from "../wizard/prompts.js";

export function hasInteractiveOnboardingTty(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY;
}

export async function runInteractiveOnboarding(
  action: () => Promise<void>,
  runtime: RuntimeEnv,
): Promise<void> {
  let exitCode: number | null = null;
  try {
    await action();
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      exitCode = 1;
      return;
    }
    throw error;
  } finally {
    // Keep stdin paused so non-daemon runs can exit cleanly (e.g. Docker setup).
    restoreTerminalState("setup finish", { resumeStdinIfPaused: false });
    if (exitCode !== null) {
      runtime.exit(exitCode);
    }
  }
}
