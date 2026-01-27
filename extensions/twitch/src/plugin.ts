/**
 * Twitch channel plugin for Moltbot.
 *
 * Main plugin export combining all adapters (outbound, actions, status, gateway).
 * This is the primary entry point for the Twitch channel integration.
 */

import type { MoltbotConfig } from "clawdbot/plugin-sdk";
import { buildChannelConfigSchema } from "clawdbot/plugin-sdk";
import { twitchMessageActions } from "./actions.js";
import { TwitchConfigSchema } from "./config-schema.js";
import { DEFAULT_ACCOUNT_ID, getAccountConfig, listAccountIds } from "./config.js";
import { twitchOnboardingAdapter } from "./onboarding.js";
import { twitchOutbound } from "./outbound.js";
import { probeTwitch } from "./probe.js";
import { resolveTwitchTargets } from "./resolver.js";
import { collectTwitchStatusIssues } from "./status.js";
import { removeClientManager } from "./client-manager-registry.js";
import { resolveTwitchToken } from "./token.js";
import { isAccountConfigured } from "./utils/twitch.js";
import type {
  ChannelAccountSnapshot,
  ChannelCapabilities,
  ChannelLogSink,
  ChannelMeta,
  ChannelPlugin,
  ChannelResolveKind,
  ChannelResolveResult,
  TwitchAccountConfig,
} from "./types.js";

/**
 * Twitch channel plugin.
 *
 * Implements the ChannelPlugin interface to provide Twitch chat integration
 * for Moltbot. Supports message sending, receiving, access control, and
 * status monitoring.
 */
export const twitchPlugin: ChannelPlugin<TwitchAccountConfig> = {
  /** Plugin identifier */
  id: "twitch",

  /** Plugin metadata */
  meta: {
    id: "twitch",
    label: "Twitch",
    selectionLabel: "Twitch (Chat)",
    docsPath: "/channels/twitch",
    blurb: "Twitch chat integration",
    aliases: ["twitch-chat"],
  } satisfies ChannelMeta,

  /** Onboarding adapter */
  onboarding: twitchOnboardingAdapter,

  /** Pairing configuration */
  pairing: {
    idLabel: "twitchUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(twitch:)?user:?/i, ""),
    notifyApproval: async ({ id }) => {
      // Note: Twitch doesn't support DMs from bots, so pairing approval is limited
      // We'll log the approval instead
      console.warn(`Pairing approved for user ${id} (notification sent via chat if possible)`);
    },
  },

  /** Supported chat capabilities */
  capabilities: {
    chatTypes: ["group"],
  } satisfies ChannelCapabilities,

  /** Configuration schema for Twitch channel */
  configSchema: buildChannelConfigSchema(TwitchConfigSchema),

  /** Account configuration management */
  config: {
    /** List all configured account IDs */
    listAccountIds: (cfg: MoltbotConfig): string[] => listAccountIds(cfg),

    /** Resolve an account config by ID */
    resolveAccount: (cfg: MoltbotConfig, accountId?: string | null): TwitchAccountConfig => {
      const account = getAccountConfig(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
      if (!account) {
        // Return a default/empty account if not configured
        return {
          username: "",
          accessToken: "",
          clientId: "",
          enabled: false,
        } as TwitchAccountConfig;
      }
      return account;
    },

    /** Get the default account ID */
    defaultAccountId: (): string => DEFAULT_ACCOUNT_ID,

    /** Check if an account is configured */
    isConfigured: (_account: unknown, cfg: MoltbotConfig): boolean => {
      const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID);
      const tokenResolution = resolveTwitchToken(cfg, { accountId: DEFAULT_ACCOUNT_ID });
      return account ? isAccountConfigured(account, tokenResolution.token) : false;
    },

    /** Check if an account is enabled */
    isEnabled: (account: TwitchAccountConfig | undefined): boolean => account?.enabled !== false,

    /** Describe account status */
    describeAccount: (account: TwitchAccountConfig | undefined) => {
      return {
        accountId: DEFAULT_ACCOUNT_ID,
        enabled: account?.enabled !== false,
        configured: account ? isAccountConfigured(account, account?.accessToken) : false,
      };
    },
  },

  /** Outbound message adapter */
  outbound: twitchOutbound,

  /** Message actions adapter */
  actions: twitchMessageActions,

  /** Resolver adapter for username -> user ID resolution */
  resolver: {
    resolveTargets: async ({
      cfg,
      accountId,
      inputs,
      kind,
      runtime,
    }: {
      cfg: MoltbotConfig;
      accountId?: string | null;
      inputs: string[];
      kind: ChannelResolveKind;
      runtime: import("../../../src/runtime.js").RuntimeEnv;
    }): Promise<ChannelResolveResult[]> => {
      const account = getAccountConfig(cfg, accountId ?? DEFAULT_ACCOUNT_ID);

      if (!account) {
        return inputs.map((input) => ({
          input,
          resolved: false,
          note: "account not configured",
        }));
      }

      // Adapt RuntimeEnv.log to ChannelLogSink
      const log: ChannelLogSink = {
        info: (msg) => runtime.log(msg),
        warn: (msg) => runtime.log(msg),
        error: (msg) => runtime.error(msg),
        debug: (msg) => runtime.log(msg),
      };
      return await resolveTwitchTargets(inputs, account, kind, log);
    },
  },

  /** Status monitoring adapter */
  status: {
    /** Default runtime state */
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },

    /** Build channel summary from snapshot */
    buildChannelSummary: ({ snapshot }: { snapshot: ChannelAccountSnapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),

    /** Probe account connection */
    probeAccount: async ({
      account,
      timeoutMs,
    }: {
      account: TwitchAccountConfig;
      timeoutMs: number;
    }): Promise<unknown> => {
      return await probeTwitch(account, timeoutMs);
    },

    /** Build account snapshot with current status */
    buildAccountSnapshot: ({
      account,
      cfg,
      runtime,
      probe,
    }: {
      account: TwitchAccountConfig;
      cfg: MoltbotConfig;
      runtime?: ChannelAccountSnapshot;
      probe?: unknown;
    }): ChannelAccountSnapshot => {
      const twitch = (cfg as Record<string, unknown>).channels as
        | Record<string, unknown>
        | undefined;
      const twitchCfg = twitch?.twitch as Record<string, unknown> | undefined;
      const accountMap = (twitchCfg?.accounts as Record<string, unknown> | undefined) ?? {};
      const resolvedAccountId =
        Object.entries(accountMap).find(([, value]) => value === account)?.[0] ??
        DEFAULT_ACCOUNT_ID;
      const tokenResolution = resolveTwitchToken(cfg, { accountId: resolvedAccountId });
      return {
        accountId: resolvedAccountId,
        enabled: account?.enabled !== false,
        configured: isAccountConfigured(account, tokenResolution.token),
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        probe,
      };
    },

    /** Collect status issues for all accounts */
    collectStatusIssues: collectTwitchStatusIssues,
  },

  /** Gateway adapter for connection lifecycle */
  gateway: {
    /** Start an account connection */
    startAccount: async (ctx): Promise<void> => {
      const account = ctx.account as TwitchAccountConfig;
      const accountId = ctx.accountId;

      ctx.setStatus?.({
        accountId,
        running: true,
        lastStartAt: Date.now(),
        lastError: null,
      });

      ctx.log?.info(`Starting Twitch connection for ${account.username}`);

      // Lazy import: the monitor pulls the reply pipeline; avoid ESM init cycles.
      const { monitorTwitchProvider } = await import("./monitor.js");
      await monitorTwitchProvider({
        account,
        accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },

    /** Stop an account connection */
    stopAccount: async (ctx): Promise<void> => {
      const account = ctx.account as TwitchAccountConfig;
      const accountId = ctx.accountId;

      // Disconnect and remove client manager from registry
      await removeClientManager(accountId);

      ctx.setStatus?.({
        accountId,
        running: false,
        lastStopAt: Date.now(),
      });

      ctx.log?.info(`Stopped Twitch connection for ${account.username}`);
    },
  },
};
