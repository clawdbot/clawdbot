import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { createHybridChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { createRuntimeOutboundDelegates } from "openclaw/plugin-sdk/outbound-runtime";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { tlonChannelConfigSchema } from "./config-schema.js";
import { tlonDoctor } from "./doctor.js";
import { resolveTlonOutboundSessionRoute } from "./session-route.js";
import { createTlonSetupWizardBase, tlonSetupAdapter } from "./setup-core.js";
import {
  formatTargetHint,
  normalizeShip,
  parseTlonTarget,
  resolveTlonOutboundTarget,
} from "./targets.js";
import { listTlonAccountIds, resolveTlonAccount } from "./types.js";

const TLON_CHANNEL_ID = "tlon" as const;

const loadTlonChannelRuntime = createLazyRuntimeModule(() => import("./channel.runtime.js"));

const tlonSetupWizardProxy = createTlonSetupWizardBase({
  resolveConfigured: async ({ cfg, accountId }) =>
    await (
      await loadTlonChannelRuntime()
    ).tlonSetupWizard.status.resolveConfigured({
      cfg,
      accountId,
    }),
  resolveStatusLines: async ({ cfg, accountId, configured }) =>
    (await (
      await loadTlonChannelRuntime()
    ).tlonSetupWizard.status.resolveStatusLines?.({
      cfg,
      accountId,
      configured,
    })) ?? [],
  finalize: async (params) =>
    await (
      await loadTlonChannelRuntime()
    ).tlonSetupWizard.finalize!(params),
}) satisfies NonNullable<ChannelPlugin["setupWizard"]>;

const tlonConfigAdapter = createHybridChannelConfigAdapter({
  sectionKey: TLON_CHANNEL_ID,
  listAccountIds: listTlonAccountIds,
  resolveAccount: resolveTlonAccount,
  defaultAccountId: () => DEFAULT_ACCOUNT_ID,
  clearBaseFields: ["ship", "code", "url", "name"],
  preserveSectionOnDefaultDelete: true,
  resolveAllowFrom: (account) => account.dmAllowlist,
  formatAllowFrom: (allowFrom) =>
    allowFrom.map((entry) => normalizeShip(String(entry))).filter(Boolean),
});

export const tlonPlugin = createChatChannelPlugin({
  base: {
    id: TLON_CHANNEL_ID,
    meta: {
      id: TLON_CHANNEL_ID,
      label: "Tlon",
      selectionLabel: "Tlon (Urbit)",
      docsPath: "/channels/tlon",
      docsLabel: "tlon",
      blurb: "Decentralized messaging on Urbit",
      aliases: ["urbit"],
      order: 90,
    },
    capabilities: {
      chatTypes: ["direct", "group", "thread"],
      media: true,
      reply: true,
      threads: true,
    },
    setup: tlonSetupAdapter,
    setupWizard: tlonSetupWizardProxy,
    reload: { configPrefixes: ["channels.tlon"] },
    configSchema: tlonChannelConfigSchema,
    config: {
      ...tlonConfigAdapter,
      isConfigured: (account) => account.configured,
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.configured,
          extra: {
            ship: account.ship,
            url: account.url,
          },
        }),
    },
    doctor: tlonDoctor,
    messaging: {
      normalizeTarget: (target) => {
        const parsed = parseTlonTarget(target);
        if (!parsed) {
          return target.trim();
        }
        if (parsed.kind === "dm") {
          return parsed.ship;
        }
        return parsed.nest;
      },
      targetResolver: {
        looksLikeId: (target) => Boolean(parseTlonTarget(target)),
        hint: formatTargetHint(),
      },
      resolveOutboundSessionRoute: (params) => resolveTlonOutboundSessionRoute(params),
    },
    status: createComputedAccountStatusAdapter<ReturnType<typeof resolveTlonAccount>>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      collectStatusIssues: (accounts) => {
        return accounts.flatMap((account) => {
          if (!account.configured) {
            return [
              {
                channel: TLON_CHANNEL_ID,
                accountId: account.accountId,
                kind: "config",
                message: "Account not configured (missing ship, code, or url)",
              },
            ];
          }
          return [];
        });
      },
      buildChannelSummary: ({ snapshot }) => {
        const s = snapshot as { configured?: boolean; ship?: string; url?: string };
        return {
          configured: s.configured ?? false,
          ship: s.ship ?? null,
          url: s.url ?? null,
        };
      },
      probeAccount: async ({ account }) => {
        if (!account.configured || !account.ship || !account.url || !account.code) {
          return { ok: false, error: "Not configured" };
        }
        return await (await loadTlonChannelRuntime()).probeTlonAccount(account as never);
      },
      resolveAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        name: account.name ?? undefined,
        enabled: account.enabled,
        configured: account.configured,
        extra: {
          ship: account.ship,
          url: account.url,
        },
      }),
    }),
    gateway: {
      startAccount: async (ctx) =>
        await (await loadTlonChannelRuntime()).startTlonGatewayAccount(ctx),
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 10000,
    resolveTarget: ({ to }) => resolveTlonOutboundTarget(to),
    ...createRuntimeOutboundDelegates({
      getRuntime: loadTlonChannelRuntime,
      sendText: { resolve: (runtime) => runtime.tlonRuntimeOutbound.sendText },
      sendMedia: { resolve: (runtime) => runtime.tlonRuntimeOutbound.sendMedia },
    }),
  },
});
