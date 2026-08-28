import {
  defineChannelSetupContract,
  type ChannelSetupAdapter,
  type ChannelSetupInput,
} from "openclaw/plugin-sdk/channel-setup";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { applyAccountNameToChannelSection } from "openclaw/plugin-sdk/setup";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup-runtime";
import { decodeBuzzPrivateKey, resolveBuzzPublicKey } from "./types.js";

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

function resolveComparableCurrentKey(cfg: OpenClawConfig): string | undefined {
  const configured = cfg.channels?.buzz?.privateKey;
  if (configured !== undefined) {
    return typeof configured === "string" ? configured.trim() || undefined : undefined;
  }
  return process.env.BUZZ_PRIVATE_KEY?.trim() || undefined;
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
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: "buzz",
      accountId,
      name,
    }),
  validateInput: ({ accountId, input }) => {
    if (accountId !== DEFAULT_ACCOUNT_ID) {
      return "Buzz currently supports only the default account.";
    }
    if (!validRelayUrl(input.relayUrl)) {
      return "Buzz requires --relay-url with a ws:// or wss:// URL.";
    }
    if (input.useEnv) {
      return null;
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
  applyAccountConfig: ({ cfg, input }) => {
    const currentPrivateKey = resolveComparableCurrentKey(cfg);
    const nextPrivateKey = input.useEnv
      ? process.env.BUZZ_PRIVATE_KEY?.trim()
      : input.privateKey?.trim();
    const keepAuthTag = isSameBuzzIdentity(currentPrivateKey, nextPrivateKey);
    const { privateKey: _privateKey, authTag, ...existing } = cfg.channels?.buzz ?? {};
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        buzz: {
          ...existing,
          enabled: true,
          relayUrl: input.relayUrl?.trim(),
          ...(keepAuthTag && authTag !== undefined ? { authTag } : {}),
          ...(input.useEnv ? {} : { privateKey: input.privateKey?.trim() }),
        },
      },
    } as OpenClawConfig;
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
