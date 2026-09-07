import type { WizardPrompter } from "../wizard/prompts.js";
import { type FirstOnboardingAgent, validateFirstOnboardingAgentName } from "./onboard-agent.js";

export async function promptFirstOnboardingAgent(
  hasAuthoredRoster: boolean,
  requestedName: string | undefined,
  prompter: WizardPrompter,
  nonInteractive = false,
  options?: { team?: boolean; offerTeam?: boolean },
): Promise<FirstOnboardingAgent | undefined> {
  if (hasAuthoredRoster) {
    return undefined;
  }
  const createTeam =
    options?.team ??
    (options?.offerTeam === true &&
      !requestedName &&
      (await prompter.select({
        message: "What would you like to create?",
        initialValue: "one",
        options: [
          { value: "one", label: "One agent" },
          { value: "team", label: "A small team: a coordinator plus specialists" },
        ],
      })) === "team");
  const defaultName = createTeam ? "coordinator" : "main";
  const name =
    requestedName ??
    (nonInteractive
      ? defaultName
      : await prompter.text({
          message: createTeam
            ? "What should we call your coordinator?"
            : "What should we call your first agent?",
          initialValue: defaultName,
          validate: validateFirstOnboardingAgentName,
        }));
  return { name, ...(createTeam ? { team: true } : {}) };
}

export async function showSessionMigrationWarnings(
  prompter: WizardPrompter,
  warnings: readonly string[] | undefined,
): Promise<void> {
  if (warnings?.length) {
    await prompter.note(warnings.join("\n"), "Session history migration");
  }
}
