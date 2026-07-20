// Nostr plugin module implements channel behavior.
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import {
  createScopedDmSecurityResolver,
  createTopLevelChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { missingTargetError } from "openclaw/plugin-sdk/channel-feedback";
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";
import {
  buildPassiveChannelStatusSummary,
  buildTrafficStatusSummary,
} from "openclaw/plugin-sdk/extension-shared";
import { createComputedAccountStatusAdapter } from "openclaw/plugin-sdk/status-helpers";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildChannelConfigSchema,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  type ChannelOutboundAdapter,
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

const NOSTR_TARGET_HINT = "<npub|hex pubkey|nostr:npub...>";

function stripNostrTargetPrefix(target: string): string {
  return target.trim().replace(/^nostr:/i, "");
}

function normalizeNostrTarget(target: string): string {
  const cleaned = stripNostrTargetPrefix(target);
  try {
    return normalizePubkey(cleaned);
  } catch {
    // Invalid prefixed tokens must stay distinct from "*" so formatting cannot widen access.
    return target.trim();
  }
}

const resolveNostrDmPolicy = createScopedDmSecurityResolver<ResolvedNostrAccount>({
  channelKey: "nostr",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  defaultPolicy: "pairing",
  approveHint: formatPairingApproveHint("nostr"),
  normalizeEntry: normalizeNostrTarget,
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
    normalizeStringEntries(allowFrom)
      .map((entry) => {
        if (entry === "*") {
          return "*";
        }
        return normalizeNostrTarget(entry);
      })
      .filter(Boolean),
});

const nostrMessageAdapter = createChannelMessageAdapterFromOutbound({
  id: "nostr",
  outbound: nostrOutboundAdapter,
});

const nostrPluginOutboundAdapter: ChannelOutboundAdapter = {
  ...nostrOutboundAdapter,
  resolveTarget: ({ to }) => {
    const trimmed = to?.trim() ?? "";
    if (!trimmed) {
      return {
        ok: false,
        error: missingTargetError("Nostr", NOSTR_TARGET_HINT),
      };
    }
    const normalized = normalizeNostrTarget(trimmed);
    try {
      return { ok: true, to: normalizePubkey(normalized) };
    } catch {
      return {
        ok: false,
        error: new Error("Nostr target must be a 64-character hex pubkey or npub value"),
      };
    }
  },
};

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
      targetPrefixes: ["nostr"],
      normalizeTarget: normalizeNostrTarget,
      targetResolver: {
        looksLikeId: (input, normalized) => {
          const trimmed = normalized?.trim() || stripNostrTargetPrefix(input);
          return (
            trimmed.startsWith("npub1") ||
            trimmed.startsWith("NPUB1") ||
            /^[0-9a-fA-F]{64}$/.test(trimmed)
          );
        },
        hint: NOSTR_TARGET_HINT,
      },
      resolveOutboundSessionRoute: (params) => resolveNostrOutboundSessionRoute(params),
    },
    message: nostrMessageAdapter,
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
  outbound: nostrPluginOutboundAdapter,
});

/**
 * Publish a profile (kind:0) for a Nostr account.
 * @param accountId - Account ID (defaults to "default")
 * @param profile - Profile data to publish
 * @returns Publish results with successes and failures
 * @throws Error if account is not running
 */
export async function publishNostrProfile(
  accountId: string | undefined,
  profile: NostrProfile,
): Promise<ProfilePublishResult> {
  const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
  const bus = getActiveNostrBuses().get(resolvedAccountId);
  if (!bus) {
    throw new Error(`Nostr bus not running for account ${resolvedAccountId}`);
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
