/**
 * Interactive onboarding command entrypoint.
 *
 * It wires the Clack prompter to the setup wizard and restores terminal state
 * on every exit path so canceled setup cannot leave stdin paused.
 */
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { runSetupWizard } from "../wizard/setup.js";
import {
  hasInteractiveOnboardingTty,
  runInteractiveOnboarding,
} from "./onboard-interactive-runner.js";
import type { OnboardOptions } from "./onboard-types.js";

/** Runs the interactive setup wizard and maps user cancellation to exit code 1. */
export async function runInteractiveSetup(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const prompter = createClackPrompter();
  await runInteractiveOnboarding(
    async () => await runSetupWizard(opts, runtime, prompter),
    runtime,
  );
}

/**
 * Opens the Crestodian onboarding conversation used by the guided escape hatch.
 * The first-run greeting proposes a setup plan and keeps subsequent setup and
 * agent handoff in the same conversation.
 */
export async function runConversationalOnboarding(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  if (!hasInteractiveOnboardingTty()) {
    runtime.error(
      "Onboarding needs an interactive TTY. Use `openclaw onboard --non-interactive --accept-risk ...` for automation.",
    );
    runtime.exit(1);
    return;
  }
  const { verifySetupInference } = await import("../crestodian/setup-inference.js");
  const inference = await verifySetupInference({ runtime, bindSession: true });
  if (!inference.ok) {
    runtime.error(`Crestodian requires working inference: ${inference.error}`);
    runtime.exit(1);
    return;
  }
  const { runCrestodian } = await import("../crestodian/crestodian.js");
  await runCrestodian(
    {
      welcomeVariant: "onboarding",
      ...(opts.workspace ? { setupWorkspace: opts.workspace } : {}),
      verifiedInference: inference.binding,
    },
    runtime,
  );
}
