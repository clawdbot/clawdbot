import type {
  ChannelOutboundAdapter,
  ChannelPlugin,
  ChannelSetupInput,
  MoltbotConfig,
} from "clawdbot/plugin-sdk";
import {
  applyAccountNameToChannelSection,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "clawdbot/plugin-sdk";

import { resolveTlonAccount, listTlonAccountIds } from "./types.js";
import { formatTargetHint, normalizeShip, parseTlonTarget } from "./targets.js";
import { ensureUrbitConnectPatched, Urbit } from "./urbit/http-api.js";
import { buildMediaText, sendDm, sendGroupMessage } from "./urbit/send.js";
import { monitorTlonProvider } from "./monitor/index.js";
import { tlonChannelConfigSchema } from "./config-schema.js";
import { tlonOnboardingAdapter } from "./onboarding.js";

const TLON_CHANNEL_ID = "tlon" as const;

type TlonSetupInput = ChannelSetupInput & {
  ship?: string;
  url?: string;
  code?: string;
  groupChannels?: string[];
  dmAllowlist?: string[];
  autoDiscoverChannels?: boolean;
};

function applyTlonSetupConfig(params: {
  cfg: MoltbotConfig;
  accountId: string;
  input: TlonSetupInput;
}): MoltbotConfig {
  const { cfg, accountId, input } = params;
  const useDefault = accountId === DEFAULT_ACCOUNT_ID;
  const namedConfig = applyAccountNameToChannelSection({
    cfg,
    channelKey: "tlon",
    accountId,
    name: input.name,
  });
  const base = namedConfig.channels?.tlon ?? {};

  const payload = {
    ...(input.ship ? { ship: input.ship } : {}),
    ...(input.url ? { url: input.url } : {}),
    ...(input.code ? { code: input.code } : {}),
    ...(input.groupChannels ? { groupChannels: input.groupChannels } : {}),
    ...(input.dmAllowlist ? { dmAllowlist: input.dmAllowlist } : {}),
    ...(typeof input.autoDiscoverChannels === "boolean"
      ? { autoDiscoverChannels: input.autoDiscoverChannels }
      : {}),
  };

  if (useDefault) {
    return {
      ...namedConfig,
      channels: {
        ...namedConfig.channels,
        tlon: {
          ...base,
          enabled: true,
          ...payload,
        },
      },
    };
  }

  return {
    ...namedConfig,
    channels: {
      ...namedConfig.channels,
      tlon: {
        ...base,
        enabled: base.enabled ?? true,
        accounts: {
          ...(base as { accounts?: Record<string, unknown> }).accounts,
          [accountId]: {
            ...((base as { accounts?: Record<string, Record<string, unknown>> }).accounts?.[
              accountId
            ] ?? {}),
            enabled: true,
            ...payload,
          },
        },
      },
    },
  };
}

const tlonOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: 10000,
  resolveTarget: ({ to }) => {
    const parsed = parseTlonTarget(to ?? "");
    if (!parsed) {
      return {
        ok: false,
        error: new Error(`Invalid Tlon target. Use ${formatTargetHint()}`),
      };
    }
    if (parsed.kind === "dm") {
      return { ok: true, to: parsed.ship };
    }
    return { ok: true, to: parsed.nest };
  },
  sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => {
    const account = resolveTlonAccount(cfg as MoltbotConfig, accountId ?? undefined);
    if (!account.configured || !account.ship || !account.url || !account.code) {
      throw new Error("Tlon account not configured");
    }

    const parsed = parseTlonTarget(to);
    if (!parsed) {
      throw new Error(`Invalid Tlon target. Use ${formatTargetHint()}`);
    }

    ensureUrbitConnectPatched();
    const api = await Urbit.authenticate({
      ship: account.ship.replace(/^~/, ""),
      url: account.url,
      code: account.code,
      verbose: false,
    });

    try {
      const fromShip = normalizeShip(account.ship);
      if (parsed.kind === "dm") {
        return await sendDm({
          api,
          fromShip,
          toShip: parsed.ship,
          text,
        });
      }
      const replyId = (replyToId ?? threadId) ? String(replyToId ?? threadId) : undefined;
      return await sendGroupMessage({
        api,
        fromShip,
        hostShip: parsed.hostShip,
        channelName: parsed.channelName,
        text,
        replyToId: replyId,
      });
    } finally {
      try {
        await api.delete();
      } catch {
        // ignore cleanup errors
      }
    }
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId, threadId }) => {
    const mergedText = buildMediaText(text, mediaUrl);
    return await tlonOutbound.sendText({
      cfg,
      to,
      text: mergedText,
      accountId,
      replyToId,
      threadId,
    });
  },
};

export const tlonPlugin: ChannelPlugin = {
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
    media: false,
    reply: true,
    threads: true,
  },
  onboarding: tlonOnboardingAdapter,
  reload: { configPrefixes: ["channels.tlon"] },
  configSchema: tlonChannelConfigSchema,
  config: {
    listAccountIds: (cfg) => listTlonAccountIds(cfg as MoltbotConfig),
    resolveAccount: (cfg, accountId) => resolveTlonAccount(cfg as MoltbotConfig, accountId ?? undefined),
    defaultAccountId: () => "default",
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const useDefault = !accountId || accountId === "default";
      if (useDefault) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            tlon: {
              ...(cfg.channels?.tlon ?? {}),
              enabled,
            },
          },
        } as MoltbotConfig;
      }
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          tlon: {
            ...(cfg.channels?.tlon ?? {}),
            accounts: {
              ...(cfg.channels?.tlon?.accounts ?? {}),
              [accountId]: {
                ...(cfg.channels?.tlon?.accounts?.[accountId] ?? {}),
                enabled,
              },
            },
          },
        },
      } as MoltbotConfig;
    },
    deleteAccount: ({ cfg, accountId }) => {
      const useDefault = !accountId || accountId === "default";
      if (useDefault) {
        const { ship, code, url, name, ...rest } = cfg.channels?.tlon ?? {};
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            tlon: rest,
          },
        } as MoltbotConfig;
      }
      const { [accountId]: removed, ...remainingAccounts } = cfg.channels?.tlon?.accounts ?? {};
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          tlon: {
            ...(cfg.channels?.tlon ?? {}),
            accounts: remainingAccounts,
          },
        },
      } as MoltbotConfig;
    },
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      ship: account.ship,
      url: account.url,
    }),
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg as MoltbotConfig,
        channelKey: "tlon",
        accountId,
        name,
      }),
    validateInput: ({ cfg, accountId, input }) => {
      const setupInput = input as TlonSetupInput;
      const resolved = resolveTlonAccount(cfg as MoltbotConfig, accountId ?? undefined);
      const ship = setupInput.ship?.trim() || resolved.ship;
      const url = setupInput.url?.trim() || resolved.url;
      const code = setupInput.code?.trim() || resolved.code;
      if (!ship) return "Tlon requires --ship.";
      if (!url) return "Tlon requires --url.";
      if (!code) return "Tlon requires --code.";
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) =>
      applyTlonSetupConfig({
        cfg: cfg as MoltbotConfig,
        accountId,
        input: input as TlonSetupInput,
      }),
  },
  messaging: {
    normalizeTarget: (target) => {
      const parsed = parseTlonTarget(target);
      if (!parsed) return target.trim();
      if (parsed.kind === "dm") return parsed.ship;
      return parsed.nest;
    },
    targetResolver: {
      looksLikeId: (target) => Boolean(parseTlonTarget(target)),
      hint: formatTargetHint(),
    },
  },
  outbound: tlonOutbound,
  status: {
    defaultRuntime: {
      accountId: "default",
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
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
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      ship: snapshot.ship ?? null,
      url: snapshot.url ?? null,
    }),
    probeAccount: async ({ account }) => {
      if (!account.configured || !account.ship || !account.url || !account.code) {
        return { ok: false, error: "Not configured" };
      }
      try {
        ensureUrbitConnectPatched();
        const api = await Urbit.authenticate({
          ship: account.ship.replace(/^~/, ""),
          url: account.url,
          code: account.code,
          verbose: false,
        });
        try {
          await api.getOurName();
          return { ok: true };
        } finally {
          await api.delete();
        }
      } catch (error: any) {
        return { ok: false, error: error?.message ?? String(error) };
      }
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      ship: account.ship,
      url: account.url,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        ship: account.ship,
        url: account.url,
      });
      ctx.log?.info(`[${account.accountId}] starting Tlon provider for ${account.ship ?? "tlon"}`);
      return monitorTlonProvider({
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        accountId: account.accountId,
      });
    },
  },
};
