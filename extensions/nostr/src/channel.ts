import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import {
  createScopedDmSecurityResolver,
  createTopLevelChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  buildPassiveChannelStatusSummary,
  buildTrafficStatusSummary,
} from "openclaw/plugin-sdk/extension-shared";
import { createComputedAccountStatusAdapter } from "openclaw/plugin-sdk/status-helpers";
import {
  buildChannelConfigSchema,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  type ChannelPlugin,
} from "./channel-api.js";
import type { NostrProfile } from "./config-schema.js";
import { NostrConfigSchema } from "./config-schema.js";
import {
  getActiveNostrBuses,
  nostrOutboundAdapter,
  nostrPairingTextAdapter,
  startNostrGatewayAccount,
} from "./gateway.js";
import { normalizePubkey } from "./nostr-key-utils.js";
import type { ProfilePublishResult } from "./nostr-profile.js";
import { resolveNostrOutboundSessionRoute } from "./session-route.js";
import { nostrSetupAdapter, nostrSetupWizard } from "./setup-surface.js";
import {
  listNostrAccountIds,
  resolveDefaultNostrAccountId,
  resolveNostrAccount,
  type ResolvedNostrAccount,
} from "./types.js";

const resolveNostrDmPolicy = createScopedDmSecurityResolver<ResolvedNostrAccount>({
  channelKey: "nostr",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  defaultPolicy: "pairing",
  approveHint: formatPairingApproveHint("nostr"),
  normalizeEntry: (raw) => {
    try {
      return normalizePubkey(raw.trim().replace(/^nostr:/i, ""));
    } catch {
      return raw.trim();
    }
  },
});

const nostrConfigAdapter = createTopLevelChannelConfigAdapter<ResolvedNostrAccount>({
  sectionKey: "nostr",
  resolveAccount: (cfg) => resolveNostrAccount({ cfg }),
  listAccountIds: listNostrAccountIds,
  defaultAccountId: resolveDefaultNostrAccountId,
  deleteMode: "clear-fields",
  clearBaseFields: [
    "name",
    "defaultAccount",
    "privateKey",
    "relays",
    "dmPolicy",
    "allowFrom",
    "profile",
  ],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    allowFrom
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .map((entry) => {
        if (entry === "*") {
          return "*";
        }
        try {
          return normalizePubkey(entry);
        } catch {
          return entry;
        }
      })
      .filter(Boolean),
});

export const nostrPlugin: ChannelPlugin<ResolvedNostrAccount> = createChatChannelPlugin({
  base: {
    id: "nostr",
    meta: {
      id: "nostr",
      label: "Nostr",
      selectionLabel: "Nostr",
      docsPath: "/channels/nostr",
      docsLabel: "nostr",
      blurb: "Decentralized DMs via Nostr relays (NIP-04)",
      order: 100,
    },
    capabilities: {
      chatTypes: ["direct"], // DMs only for MVP
      media: false, // No media for MVP
    },
    reload: { configPrefixes: ["channels.nostr"] },
    configSchema: buildChannelConfigSchema(NostrConfigSchema),
    setup: nostrSetupAdapter,
    setupWizard: nostrSetupWizard,
    config: {
      ...nostrConfigAdapter,
      isConfigured: (account) => account.configured,
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.configured,
          extra: {
            publicKey: account.publicKey,
          },
        }),
    },
    messaging: {
      normalizeTarget: (target) => {
        // Strip nostr: prefix if present
        const cleaned = target.trim().replace(/^nostr:/i, "");
        try {
          return normalizePubkey(cleaned);
        } catch {
          return cleaned;
        }
      },
      targetResolver: {
        looksLikeId: (input) => {
          const trimmed = input.trim();
          return trimmed.startsWith("npub1") || /^[0-9a-fA-F]{64}$/.test(trimmed);
        },
        hint: "<npub|hex pubkey|nostr:npub...>",
      },
      resolveOutboundSessionRoute: (params) => resolveNostrOutboundSessionRoute(params),
    },
    status: {
      ...createComputedAccountStatusAdapter<ResolvedNostrAccount>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
        collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("nostr", accounts),
        buildChannelSummary: ({ snapshot }) =>
          buildPassiveChannelStatusSummary(snapshot, {
            publicKey: snapshot.publicKey ?? null,
          }),
        resolveAccountSnapshot: ({ account, runtime }) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: account.configured,
          extra: {
            publicKey: account.publicKey,
            profile: account.profile,
            ...buildTrafficStatusSummary(runtime),
          },
        }),
      }),
    },
    gateway: {
      startAccount: startNostrGatewayAccount,
    },
  },
  pairing: {
    text: nostrPairingTextAdapter,
  },
  security: {
    resolveDmPolicy: resolveNostrDmPolicy,
  },
  outbound: nostrOutboundAdapter,
});

/**
 * Publish a profile (kind:0) for a Nostr account.
 * @param accountId - Account ID (defaults to "default")
 * @param profile - Profile data to publish
 * @returns Publish results with successes and failures
 * @throws Error if account is not running
 */
export async function publishNostrProfile(
  accountId: string = DEFAULT_ACCOUNT_ID,
  profile: NostrProfile,
): Promise<ProfilePublishResult> {
  const bus = getActiveNostrBuses().get(accountId);
  if (!bus) {
    throw new Error(`Nostr bus not running for account ${accountId}`);
  }
  return bus.publishProfile(profile);
}

/**
 * Get profile publish state for a Nostr account.
 * @param accountId - Account ID (defaults to "default")
 * @returns Profile publish state or null if account not running
 */
export async function getNostrProfileState(accountId: string = DEFAULT_ACCOUNT_ID): Promise<{
  lastPublishedAt: number | null;
  lastPublishedEventId: string | null;
  lastPublishResults: Record<string, "ok" | "failed" | "timeout"> | null;
} | null> {
  const bus = getActiveNostrBuses().get(accountId);
  if (!bus) {
    return null;
  }
  return bus.getProfileState();
}

export { getActiveNostrBuses, getNostrMetrics } from "./gateway.js";
