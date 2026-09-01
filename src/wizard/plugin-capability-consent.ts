import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatPluginCapabilityConsentLines } from "../cli/plugin-capability-consent.js";
import type { PluginCapabilityConsentHandler } from "../plugins/capability-consent.js";
import type { WizardPrompter } from "./prompts.js";

/** Present the same artifact review in terminal and Gateway-backed setup wizards. */
export function createPluginCapabilityConsentPrompter(
  prompter: Pick<WizardPrompter, "note" | "confirm" | "cancel">,
  beforePersistentEffect?: () => void | Promise<void>,
): PluginCapabilityConsentHandler {
  return async (review) => {
    await prompter.note(
      formatPluginCapabilityConsentLines(review).join("\n"),
      "Plugin capabilities",
    );
    if (
      !(await prompter.confirm({
        message: `Accept these capabilities for "${sanitizeTerminalText(review.pluginId)}"?`,
        initialValue: false,
      }))
    ) {
      // A refused capability review ends this setup attempt, rather than selecting
      // another route or leaving remote clients to interpret an installer error.
      return prompter.cancel?.("Plugin capability review was declined.");
    }
    await beforePersistentEffect?.();
    return { reviewToken: review.reviewToken };
  };
}
