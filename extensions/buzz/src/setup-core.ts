import {
  defineChannelSetupContract,
  type ChannelSetupAdapter,
  type ChannelSetupInput,
} from "openclaw/plugin-sdk/channel-setup";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { patchScopedAccountConfig } from "openclaw/plugin-sdk/setup";
import { decodeBuzzPrivateKey, resolveBuzzAccountConfig, resolveBuzzPublicKey } from "./types.js";

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

export function patchBuzzAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Record<string, unknown>;
  clearFields?: readonly string[];
}): OpenClawConfig {
  const { accountId, allowEnv } = resolveBuzzAccountConfig(params);
  return patchScopedAccountConfig({
    ...params,
    accountId,
    channelKey: "buzz",
    scopeDefaultToAccounts: !allowEnv,
    ensureChannelEnabled: false,
    ensureAccountEnabled: false,
  });
}

function resolveComparableCurrentKey(cfg: OpenClawConfig, accountId: string): string | undefined {
  const { config, allowEnv } = resolveBuzzAccountConfig({ cfg, accountId });
  const configured = config.privateKey;
  if (configured !== undefined) {
    return typeof configured === "string" ? configured.trim() || undefined : undefined;
  }
  return allowEnv ? process.env.BUZZ_PRIVATE_KEY?.trim() || undefined : undefined;
}

function isSameBuzzIdentity(currentKey?: string, nextKey?: string): boolean {
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
  configPromotion: "preserve-root",
  resolveAccountId: ({ cfg, accountId }) => resolveBuzzAccountConfig({ cfg, accountId }).accountId,
  applyAccountName: ({ cfg, accountId, name }) =>
    name?.trim() ? patchBuzzAccountConfig({ cfg, accountId, patch: { name: name.trim() } }) : cfg,
  validateInput: ({ cfg, accountId, input }) => {
    if (!validRelayUrl(input.relayUrl)) {
      return "Buzz requires --relay-url with a ws:// or wss:// URL.";
    }
    if (input.useEnv) {
      return resolveBuzzAccountConfig({ cfg, accountId }).allowEnv
        ? null
        : "Buzz --use-env is only supported for the root default identity; use an explicit private key or SecretRef for this account.";
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
    const currentPrivateKey = resolveComparableCurrentKey(cfg, accountId);
    const nextPrivateKey = input.useEnv
      ? process.env.BUZZ_PRIVATE_KEY?.trim()
      : input.privateKey?.trim();
    const keepAuthTag = isSameBuzzIdentity(currentPrivateKey, nextPrivateKey);
    return patchBuzzAccountConfig({
      cfg,
      accountId,
      clearFields: ["privateKey", ...(keepAuthTag ? [] : ["authTag"])],
      patch: {
        enabled: true,
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
        relayUrl: input.relayUrl?.trim(),
        ...(input.useEnv ? {} : { privateKey: input.privateKey?.trim() }),
      },
    });
  },
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
