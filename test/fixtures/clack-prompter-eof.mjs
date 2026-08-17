import { runInteractiveOnboarding } from "../../src/commands/onboard-interactive-runner.ts";
import { defaultRuntime } from "../../src/runtime.ts";
import { createClackPrompter } from "../../src/wizard/clack-prompter.ts";

const prompter = createClackPrompter();
await runInteractiveOnboarding(async () => {
  await prompter.confirm({ message: "Continue?", initialValue: false });
}, defaultRuntime);
