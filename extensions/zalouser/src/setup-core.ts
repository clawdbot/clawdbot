import {
  createDelegatedSetupWizardProxy,
  createPatchedAccountSetupAdapter,
  createSetupTranslator,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup-runtime";

const t = createSetupTranslator();

const channel = "zalouser" as const;

export const zalouserSetupAdapter = createPatchedAccountSetupAdapter({
  channelKey: channel,
  validateInput: () => null,
  buildPatch: () => ({}),
});

export function createZalouserSetupWizardProxy(
  loadWizard: () => Promise<ChannelSetupWizard>,
): ChannelSetupWizard {
  return createDelegatedSetupWizardProxy({
    channel,
    loadWizard,
    status: {
      configuredLabel: t("wizard.channels.statusLoggedIn"),
      unconfiguredLabel: t("wizard.channels.statusNeedsQrLogin"),
      configuredHint: t("wizard.channels.statusRecommendedLoggedIn"),
      unconfiguredHint: t("wizard.channels.statusRecommendedQrLogin"),
      configuredScore: 1,
      unconfiguredScore: 15,
    },
    credentials: [],
    delegatePrepare: true,
    delegateFinalize: true,
  });
}
