// Nostr plugin module implements setup adapter behavior.
import {
  defineChannelSetupContract,
  type ChannelSetupAdapter,
} from "openclaw/plugin-sdk/channel-setup";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import {
  createSetupTranslator,
  createStandardChannelSetupStatus,
  patchTopLevelChannelConfigSection,
  splitSetupEntries,
} from "openclaw/plugin-sdk/setup";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { DEFAULT_RELAYS } from "./default-relays.js";

const channel = "nostr" as const;

type NostrSetupInput = {
  name?: string;
  privateKey?: string;
  relayUrls?: string;
  useEnv?: boolean;
};

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
  return { relays: uniqueStrings(relays) };
}

export function createNostrSetupAdapter(params: {
  resolveAccountId: (cfg: OpenClawConfig, accountId?: string | null) => string;
  validatePrivateKey: (privateKey: string) => boolean;
}): ChannelSetupAdapter<NostrSetupInput> {
  return {
    resolveAccountId: ({ cfg, accountId }) => params.resolveAccountId(cfg, accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      patchTopLevelChannelConfigSection({
        cfg,
        channel,
        patch: buildNostrSetupPatch(accountId, name?.trim() ? { name: name.trim() } : {}),
      }),
    validateInput: ({ input }) => {
      if (!input.useEnv) {
        const privateKey = input.privateKey?.trim();
        if (!privateKey) {
          return "Nostr requires --private-key or --use-env.";
        }
        if (!params.validatePrivateKey(privateKey)) {
          return "Nostr private key must be valid nsec or 64-character hex.";
        }
      }
      if (input.relayUrls?.trim()) {
        return parseRelayUrls(input.relayUrls).error ?? null;
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const relayResult = input.relayUrls?.trim()
        ? parseRelayUrls(input.relayUrls)
        : { relays: [] };
      return patchTopLevelChannelConfigSection({
        cfg,
        channel,
        enabled: true,
        clearFields: input.useEnv ? ["privateKey"] : undefined,
        patch: buildNostrSetupPatch(accountId, {
          ...(input.useEnv ? {} : { privateKey: input.privateKey?.trim() }),
          ...(relayResult.relays.length > 0 ? { relays: relayResult.relays } : {}),
        }),
      });
    },
  };
}

export function createNostrSetupContract(adapter: ChannelSetupAdapter<NostrSetupInput>) {
  return defineChannelSetupContract({
    fields: {
      privateKey: {
        kind: "string",
        sensitive: true,
        cli: { flags: "--private-key <key>", description: "Nostr private key" },
      },
      relayUrls: {
        kind: "string",
        cli: { flags: "--relay-urls <urls>", description: "Nostr relay URLs" },
      },
      useEnv: {
        kind: "boolean",
        cli: { flags: "--use-env", description: "Use NOSTR_PRIVATE_KEY" },
      },
    },
    adapter,
  });
}

export function createNostrSetupStatus(
  resolveAccount: (params: { cfg: OpenClawConfig; accountId?: string | null }) => {
    configured: boolean;
    relays: string[];
  },
) {
  const t = createSetupTranslator();
  return createStandardChannelSetupStatus({
    channelLabel: "Nostr",
    configuredLabel: t("wizard.channels.statusConfigured"),
    unconfiguredLabel: t("wizard.channels.statusNeedsPrivateKey"),
    configuredHint: t("wizard.channels.statusConfigured"),
    unconfiguredHint: t("wizard.channels.statusNeedsPrivateKey"),
    configuredScore: 1,
    unconfiguredScore: 0,
    includeStatusLine: true,
    resolveConfigured: ({ cfg, accountId }) => resolveAccount({ cfg, accountId }).configured,
    resolveExtraStatusLines: ({ cfg }) => {
      const account = resolveAccount({ cfg });
      return [`Relays: ${account.relays.length || DEFAULT_RELAYS.length}`];
    },
  });
}
