import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
// Whatsapp plugin module implements setup core behavior.
import {
  createPatchedAccountSetupAdapter,
  type ChannelSetupAdapter,
  type ChannelSetupInput,
} from "openclaw/plugin-sdk/setup";

const channel = "whatsapp" as const;

type WhatsAppSetupInput = ChannelSetupInput & {
  authDir?: string;
};

export const whatsappSetupAdapter: ChannelSetupAdapter = {
  ...createPatchedAccountSetupAdapter<WhatsAppSetupInput>({
    channelKey: channel,
    alwaysUseAccounts: true,
    buildPatch: (input) => (input.authDir ? { authDir: input.authDir } : {}),
  }),
  singleAccountKeysToMove: ["authDir"],
};

export const whatsappSetupContract = defineChannelSetupContract({
  fields: {
    authDir: {
      kind: "string",
      cli: { flags: "--auth-dir <path>", description: "WhatsApp auth directory override" },
    },
  },
  legacyAdapter: whatsappSetupAdapter,
});
