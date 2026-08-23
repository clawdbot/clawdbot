import type { WizardPrompter } from "../wizard/prompts.js";
import { type FirstOnboardingAgent, validateFirstOnboardingAgentName } from "./onboard-agent.js";

export async function promptFirstOnboardingAgent(
  hasAuthoredRoster: boolean,
  requestedName: string | undefined,
  prompter: WizardPrompter,
  nonInteractive = false,
): Promise<FirstOnboardingAgent | undefined> {
  if (hasAuthoredRoster) {
    return undefined;
  }
  const name =
    requestedName ??
    (nonInteractive
      ? "main"
      : await prompter.text({
          message: "What should we call your first agent?",
          initialValue: "main",
          validate: validateFirstOnboardingAgentName,
        }));
  return { name };
}

export async function showSessionMigrationWarnings(
  prompter: WizardPrompter,
  warnings: readonly string[] | undefined,
): Promise<void> {
  if (warnings?.length) {
    await prompter.note(warnings.join("\n"), "Session history migration");
  }
}
