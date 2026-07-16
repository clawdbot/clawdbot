import { createDiscordSetupWizardProxy } from "./setup-core.js";

type DiscordSetupWizard = typeof import("./setup-surface.js").discordSetupWizard;

export const discordSetupWizard: DiscordSetupWizard = createDiscordSetupWizardProxy(
  async () => (await import("./setup-surface.js")).discordSetupWizard,
);
