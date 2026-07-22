// Whatsapp plugin module implements setup core behavior.
import {
  applyAccountNameToChannelSection,
  type ChannelSetupAdapter,
  type ChannelSetupInput,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
} from "openclaw/plugin-sdk/setup";

const channel = "whatsapp" as const;

type WhatsAppSetupInput = ChannelSetupInput & {
  authDir?: string;
};

export const whatsappSetupAdapter: ChannelSetupAdapter = {
  singleAccountKeysToMove: ["authDir"],
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name,
      alwaysUseAccounts: true,
    }),
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const setupInput = input as WhatsAppSetupInput;
    const namedConfig = applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name: setupInput.name,
      alwaysUseAccounts: true,
    });
    const next = migrateBaseNameToDefaultAccount({
      cfg: namedConfig,
      channelKey: channel,
      alwaysUseAccounts: true,
    });
    const entry = {
      ...next.channels?.whatsapp?.accounts?.[accountId],
      ...(setupInput.authDir ? { authDir: setupInput.authDir } : {}),
      enabled: true,
    };
    return {
      ...next,
      channels: {
        ...next.channels,
        whatsapp: {
          ...next.channels?.whatsapp,
          accounts: {
            ...next.channels?.whatsapp?.accounts,
            [accountId]: entry,
          },
        },
      },
    };
  },
};
