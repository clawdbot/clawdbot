import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatPluginCapabilityConsentLines } from "../cli/plugin-capability-consent.js";
import type { PluginCapabilityConsentHandler } from "../plugins/capability-consent.js";
import type { WizardPrompter } from "./prompts.js";

/** Present the same artifact review in terminal and Gateway-backed setup wizards. */
export function createPluginCapabilityConsentPrompter(
  prompter: Pick<WizardPrompter, "note" | "confirm">,
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
      return undefined;
    }
    await beforePersistentEffect?.();
    return { reviewToken: review.reviewToken };
  };
}
