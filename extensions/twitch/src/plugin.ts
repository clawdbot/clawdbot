/**
 * Twitch channel plugin for OpenClaw.
 *
 * Main plugin export combining all adapters (outbound, actions, status, gateway).
 * This is the primary entry point for the Twitch channel integration.
 */

import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  createLoggedPairingApprovalNotifier,
  createPairingPrefixStripper,
} from "openclaw/plugin-sdk/channel-pairing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { buildPassiveProbedChannelStatusSummary } from "openclaw/plugin-sdk/extension-shared";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { twitchMessageActions } from "./actions.js";
import { removeClientManager } from "./client-manager-registry.js";
import { TwitchConfigSchema } from "./config-schema.js";
import {
  DEFAULT_ACCOUNT_ID,
  getAccountConfig,
  listAccountIds,
  resolveDefaultTwitchAccountId,
  resolveTwitchAccountContext,
  resolveTwitchSnapshotAccountId,
} from "./config.js";
import { twitchOutbound } from "./outbound.js";
import { probeTwitch } from "./probe.js";
import { resolveTwitchTargets } from "./resolver.js";
import { twitchSetupAdapter, twitchSetupWizard } from "./setup-surface.js";
import { collectTwitchStatusIssues } from "./status.js";
import type {
  ChannelLogSink,
  ChannelPlugin,
  ChannelResolveKind,
  ChannelResolveResult,
  TwitchAccountConfig,
} from "./types.js";
import { isAccountConfigured } from "./utils/twitch.js";

type ResolvedTwitchAccount = TwitchAccountConfig & { accountId?: string | null };

/**
 * Twitch channel plugin.
 *
 * Implements the ChannelPlugin interface to provide Twitch chat integration
 * for OpenClaw. Supports message sending, receiving, access control, and
 * status monitoring.
 */
export const twitchPlugin: ChannelPlugin<ResolvedTwitchAccount> =
  createChatChannelPlugin<ResolvedTwitchAccount>({
    pairing: {
      idLabel: "twitchUserId",
      normalizeAllowEntry: createPairingPrefixStripper(/^(twitch:)?user:?/i),
      notifyApproval: createLoggedPairingApprovalNotifier(
        ({ id }) => `Pairing approved for user ${id} (notification sent via chat if possible)`,
        console.warn,
      ),
    },
    outbound: twitchOutbound,
    base: {
      id: "twitch",
      meta: {
        id: "twitch",
        label: "Twitch",
        selectionLabel: "Twitch (Chat)",
        docsPath: "/channels/twitch",
        blurb: "Twitch chat integration",
        aliases: ["twitch-chat"],
      },
      setup: twitchSetupAdapter,
      setupWizard: twitchSetupWizard,
      capabilities: {
        chatTypes: ["group"],
      },
      configSchema: buildChannelConfigSchema(TwitchConfigSchema),
      config: {
        listAccountIds: (cfg: OpenClawConfig): string[] => listAccountIds(cfg),
        resolveAccount: (cfg: OpenClawConfig, accountId?: string | null): ResolvedTwitchAccount => {
          const resolvedAccountId = accountId ?? resolveDefaultTwitchAccountId(cfg);
          const account = getAccountConfig(cfg, resolvedAccountId);
          if (!account) {
            return {
              accountId: resolvedAccountId,
              channel: "",
              username: "",
              accessToken: "",
              clientId: "",
              enabled: false,
            };
          }
          return {
            accountId: resolvedAccountId,
            ...account,
          };
        },
        defaultAccountId: (cfg: OpenClawConfig): string => resolveDefaultTwitchAccountId(cfg),
        isConfigured: (_account: unknown, cfg: OpenClawConfig): boolean =>
          resolveTwitchAccountContext(cfg).configured,
        isEnabled: (account: ResolvedTwitchAccount | undefined): boolean =>
          account?.enabled !== false,
        describeAccount: (account: TwitchAccountConfig | undefined) =>
          account
            ? describeAccountSnapshot({
                account,
                configured: isAccountConfigured(account, account.accessToken),
              })
            : {
                accountId: DEFAULT_ACCOUNT_ID,
                enabled: false,
                configured: false,
              },
      },
      actions: twitchMessageActions,
      resolver: {
        resolveTargets: async ({
          cfg,
          accountId,
          inputs,
          kind,
          runtime,
        }: {
          cfg: OpenClawConfig;
          accountId?: string | null;
          inputs: string[];
          kind: ChannelResolveKind;
          runtime: import("openclaw/plugin-sdk/runtime-env").RuntimeEnv;
        }): Promise<ChannelResolveResult[]> => {
          const account = getAccountConfig(cfg, accountId ?? resolveDefaultTwitchAccountId(cfg));
          if (!account) {
            return inputs.map((input) => ({
              input,
              resolved: false,
              note: "account not configured",
            }));
          }

          const log: ChannelLogSink = {
            info: (msg) => runtime.log(msg),
            warn: (msg) => runtime.log(msg),
            error: (msg) => runtime.error(msg),
            debug: (msg) => runtime.log(msg),
          };
          return await resolveTwitchTargets(inputs, account, kind, log);
        },
      },
      status: createComputedAccountStatusAdapter<ResolvedTwitchAccount>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
        buildChannelSummary: ({ snapshot }) => buildPassiveProbedChannelStatusSummary(snapshot),
        probeAccount: async ({ account, timeoutMs }) => await probeTwitch(account, timeoutMs),
        collectStatusIssues: collectTwitchStatusIssues,
        resolveAccountSnapshot: ({ account, cfg }) => {
          const resolvedAccountId =
            account.accountId || resolveTwitchSnapshotAccountId(cfg, account);
          const { configured } = resolveTwitchAccountContext(cfg, resolvedAccountId);
          return {
            accountId: resolvedAccountId,
            enabled: account.enabled !== false,
            configured,
          };
        },
      }),
      gateway: {
        startAccount: async (ctx): Promise<void> => {
          const account = ctx.account;
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
        stopAccount: async (ctx): Promise<void> => {
          const account = ctx.account;
          const accountId = ctx.accountId;

          await removeClientManager(accountId);

          ctx.setStatus?.({
            accountId,
            running: false,
            lastStopAt: Date.now(),
          });

          ctx.log?.info(`Stopped Twitch connection for ${account.username}`);
        },
      },
    },
  });
