import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  defineChannelSetupContract,
  type ChannelSetupAdapter,
  type ChannelSetupInput,
} from "openclaw/plugin-sdk/channel-setup";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  applyAccountNameToChannelSection,
  moveSingleAccountChannelSectionToDefaultAccount,
  patchScopedAccountConfig,
} from "openclaw/plugin-sdk/setup";
import { decodeBuzzPrivateKey, resolveBuzzAccount, resolveBuzzPublicKey } from "./types.js";

type BuzzSetupInput = ChannelSetupInput & {
  relayUrl?: string;
  privateKey?: string;
};

function validRelayUrl(value: string | undefined): boolean {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "ws:" || url.protocol === "wss:";
  } catch {
    return false;
  }
}

function resolveComparableCurrentKey(cfg: OpenClawConfig, accountId: string): string | undefined {
  return resolveBuzzAccount({ cfg, accountId }).privateKey || undefined;
}

export function isSameBuzzIdentity(currentKey?: string, nextKey?: string): boolean {
  if (!currentKey || !nextKey) {
    return false;
  }
  try {
    return resolveBuzzPublicKey(currentKey) === resolveBuzzPublicKey(nextKey);
  } catch {
    return false;
  }
}

const buzzSetupAdapter: ChannelSetupAdapter<BuzzSetupInput> = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: "buzz",
      accountId,
      name,
    }),
  validateInput: ({ accountId, input }) => {
    if (!validRelayUrl(input.relayUrl)) {
      return "Buzz requires --relay-url with a ws:// or wss:// URL.";
    }
    if (input.useEnv) {
      return accountId === DEFAULT_ACCOUNT_ID
        ? null
        : "Buzz --use-env is only available for the default account.";
    }
    const privateKey = input.privateKey?.trim();
    if (!privateKey) {
      return "Buzz requires --private-key or --use-env.";
    }
    try {
      decodeBuzzPrivateKey(privateKey);
    } catch (error) {
      return error instanceof Error ? error.message : "Invalid Buzz private key.";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const scopedConfig =
      accountId !== DEFAULT_ACCOUNT_ID || cfg.channels?.buzz?.accounts
        ? moveSingleAccountChannelSectionToDefaultAccount({
            cfg,
            channelKey: "buzz",
            setupSurface: buzzSetupContract,
          })
        : cfg;
    const currentAccount = resolveBuzzAccount({ cfg: scopedConfig, accountId });
    const currentPrivateKey = resolveComparableCurrentKey(scopedConfig, accountId);
    const nextPrivateKey = input.useEnv
      ? process.env.BUZZ_PRIVATE_KEY?.trim()
      : input.privateKey?.trim();
    const keepAuthTag = isSameBuzzIdentity(currentPrivateKey, nextPrivateKey);
    const namedConfig = applyAccountNameToChannelSection({
      cfg: scopedConfig,
      channelKey: "buzz",
      accountId,
      name: input.name,
    });
    return patchScopedAccountConfig({
      cfg: namedConfig,
      channelKey: "buzz",
      accountId,
      patch: {
        relayUrl: input.relayUrl?.trim(),
        ...(keepAuthTag && currentAccount.config.authTag !== undefined
          ? { authTag: currentAccount.config.authTag }
          : {}),
        ...(input.useEnv ? {} : { privateKey: input.privateKey?.trim() }),
      },
      clearFields: ["privateKey", "authTag"],
      scopeDefaultToAccounts: Boolean(namedConfig.channels?.buzz?.accounts),
    });
  },
  singleAccountKeysToMove: ["relayUrl", "privateKey", "authTag"],
  namedAccountPromotionKeys: ["name", "relayUrl", "privateKey", "authTag", "groups", "defaultTo"],
  resolveSingleAccountPromotionTarget: () => DEFAULT_ACCOUNT_ID,
};

export const buzzSetupContract = defineChannelSetupContract({
  fields: {
    relayUrl: {
      kind: "string",
      cli: { flags: "--relay-url <url>", description: "Buzz relay WebSocket URL" },
    },
    privateKey: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--private-key <key>", description: "Buzz bot Nostr private key" },
    },
    useEnv: {
      kind: "boolean",
      cli: {
        flags: "--use-env",
        description: "Use BUZZ_PRIVATE_KEY with the supplied relay URL",
      },
      envVars: ["BUZZ_PRIVATE_KEY"],
    },
  },
  adapter: buzzSetupAdapter,
});
