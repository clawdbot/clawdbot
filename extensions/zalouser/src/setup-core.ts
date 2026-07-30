import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
// Zalouser plugin module implements setup core behavior.
import {
  createDelegatedSetupWizardProxy,
  createPatchedAccountSetupAdapter,
  createSetupTranslator,
  type ChannelSetupAdapter,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup-runtime";

const t = createSetupTranslator();

const channel = "zalouser" as const;

export const zalouserSetupAdapter: ChannelSetupAdapter = {
  ...createPatchedAccountSetupAdapter({
    channelKey: channel,
    validateInput: () => null,
    buildPatch: () => ({}),
  }),
  singleAccountKeysToMove: [],
};

export const zalouserSetupContract = defineChannelSetupContract({
  fields: {},
  legacyAdapter: zalouserSetupAdapter,
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
