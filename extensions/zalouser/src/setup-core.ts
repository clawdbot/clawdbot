import {
  createDelegatedSetupWizardProxy,
  createPatchedAccountSetupAdapter,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup-runtime";

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
      configuredLabel: "logged in",
      unconfiguredLabel: "needs QR login",
      configuredHint: "recommended · logged in",
      unconfiguredHint: "recommended · QR login",
      configuredScore: 1,
      unconfiguredScore: 15,
    },
    credentials: [],
    delegatePrepare: true,
    delegateFinalize: true,
  });
}
