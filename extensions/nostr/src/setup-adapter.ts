import type { ChannelSetupAdapter } from "openclaw/plugin-sdk/channel-setup";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { patchTopLevelChannelConfigSection, splitSetupEntries } from "openclaw/plugin-sdk/setup";

const channel = "nostr" as const;

export function buildNostrSetupPatch(accountId: string, patch: Record<string, unknown>) {
  return {
    ...(accountId !== DEFAULT_ACCOUNT_ID ? { defaultAccount: accountId } : {}),
    ...patch,
  };
}

export function parseRelayUrls(raw: string): { relays: string[]; error?: string } {
  const relays: string[] = [];
  for (const entry of splitSetupEntries(raw)) {
    try {
      const parsed = new URL(entry);
      if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        return { relays: [], error: `Relay must use ws:// or wss:// (${entry})` };
      }
    } catch {
      return { relays: [], error: `Invalid relay URL: ${entry}` };
    }
    relays.push(entry);
  }
  return { relays: [...new Set(relays)] };
}

export function createNostrSetupAdapter(params: {
  resolveAccountId: (cfg: OpenClawConfig, accountId?: string | null) => string;
  validatePrivateKey: (privateKey: string) => boolean;
}): ChannelSetupAdapter {
  return {
    resolveAccountId: ({ cfg, accountId }) => params.resolveAccountId(cfg, accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      patchTopLevelChannelConfigSection({
        cfg,
        channel,
        patch: buildNostrSetupPatch(accountId, name?.trim() ? { name: name.trim() } : {}),
      }),
    validateInput: ({ input }) => {
      const typedInput = input as {
        useEnv?: boolean;
        privateKey?: string;
        relayUrls?: string;
      };
      if (!typedInput.useEnv) {
        const privateKey = typedInput.privateKey?.trim();
        if (!privateKey) {
          return "Nostr requires --private-key or --use-env.";
        }
        if (!params.validatePrivateKey(privateKey)) {
          return "Nostr private key must be valid nsec or 64-character hex.";
        }
      }
      if (typedInput.relayUrls?.trim()) {
        return parseRelayUrls(typedInput.relayUrls).error ?? null;
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const typedInput = input as {
        useEnv?: boolean;
        privateKey?: string;
        relayUrls?: string;
      };
      const relayResult = typedInput.relayUrls?.trim()
        ? parseRelayUrls(typedInput.relayUrls)
        : { relays: [] };
      return patchTopLevelChannelConfigSection({
        cfg,
        channel,
        enabled: true,
        clearFields: typedInput.useEnv ? ["privateKey"] : undefined,
        patch: buildNostrSetupPatch(accountId, {
          ...(typedInput.useEnv ? {} : { privateKey: typedInput.privateKey?.trim() }),
          ...(relayResult.relays.length > 0 ? { relays: relayResult.relays } : {}),
        }),
      });
    },
  };
}
