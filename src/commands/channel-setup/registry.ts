import type { ChannelSetupWizardAdapter } from "../../channels/plugins/setup-wizard-types.js";
// Adapts declarative and imperative channel setup wizards to the command-facing interface.
import { buildChannelSetupWizardAdapterFromSetupWizard } from "../../channels/plugins/setup-wizard.js";
import type { ChannelSetupWizard } from "../../channels/plugins/setup-wizard.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";

const setupWizardAdapters = new WeakMap<object, ChannelSetupWizardAdapter>();

function isChannelSetupWizardAdapter(
  setupWizard: ChannelPlugin["setupWizard"],
): setupWizard is ChannelSetupWizardAdapter {
  return Boolean(
    setupWizard &&
    typeof setupWizard === "object" &&
    "getStatus" in setupWizard &&
    typeof setupWizard.getStatus === "function" &&
    "configure" in setupWizard &&
    typeof setupWizard.configure === "function",
  );
}

function isDeclarativeChannelSetupWizard(
  setupWizard: ChannelPlugin["setupWizard"],
): setupWizard is ChannelSetupWizard {
  return Boolean(
    setupWizard &&
    typeof setupWizard === "object" &&
    "status" in setupWizard &&
    "credentials" in setupWizard,
  );
}

/** Resolve the setup wizard adapter exposed by one channel plugin, caching declarative adapters. */
export function resolveChannelSetupWizardAdapterForPlugin(
  plugin?: ChannelPlugin,
): ChannelSetupWizardAdapter | undefined {
  if (!plugin) {
    return undefined;
  }
  const { setupWizard } = plugin;
  if (isChannelSetupWizardAdapter(setupWizard)) {
    return setupWizard;
  }
  if (isDeclarativeChannelSetupWizard(setupWizard)) {
    const cached = setupWizardAdapters.get(plugin);
    if (cached) {
      return cached;
    }
    const adapter = buildChannelSetupWizardAdapterFromSetupWizard({
      plugin,
      wizard: setupWizard,
    });
    setupWizardAdapters.set(plugin, adapter);
    return adapter;
  }
  return undefined;
}
