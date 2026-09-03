/**
 * Twitch channel plugin for OpenClaw.
 *
 * Main plugin export combining all adapters (outbound, actions, status, gateway).
 * This is the primary entry point for the Twitch channel integration.
 */

import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
  stripChannelTargetPrefix,
  type PluginRuntime,
} from "openclaw/plugin-sdk/channel-core";
import {
  createAccountStatusSink,
  runPassiveAccountLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  createLoggedPairingApprovalNotifier,
  createPairingPrefixStripper,
} from "openclaw/plugin-sdk/channel-pairing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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
  resolveDefaultTwitchAccountId,
  resolveTwitchAccountContext,
  resolveTwitchSnapshotAccountId,
  twitchConfigAdapter,
  type ResolvedTwitchAccount,
} from "./config.js";
import { twitchMessageAdapter, twitchOutbound } from "./outbound.js";
import { probeTwitch } from "./probe.js";
import { resolveTwitchTargets } from "./resolver.js";
import { twitchSetupContract, twitchSetupWizard } from "./setup-surface.js";
import { collectTwitchStatusIssues } from "./status.js";
import type {
  ChannelLogSink,
  ChannelPlugin,
  ChannelResolveKind,
  ChannelResolveResult,
  TwitchAccountConfig,
} from "./types.js";
import { isAccountConfigured, normalizeTwitchChannel } from "./utils/twitch.js";

function normalizeTwitchMessagingTarget(target: string): string {
  const providerTarget = stripChannelTargetPrefix(target, "twitch", "twitch-chat");
  const kindMatch = /^(user|dm|channel|group|conversation|room):/i.exec(providerTarget);
  const kind = kindMatch?.[1]?.toLowerCase();
  if (kind === "user" || kind === "dm") {
    return "";
  }
  const channelTarget = kindMatch ? providerTarget.slice(kindMatch[0].length) : providerTarget;
  return normalizeTwitchChannel(channelTarget);
}

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
    threading: {
      matchesToolContextTarget: ({ target, toolContext }) => {
        const channel = normalizeTwitchMessagingTarget(target);
        return (
          Boolean(channel) &&
          [toolContext.currentChannelId, toolContext.currentMessagingTarget].some(
            (current) => current != null && normalizeTwitchMessagingTarget(current) === channel,
          )
        );
      },
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
      setupContract: twitchSetupContract,
      setupWizard: twitchSetupWizard,
      capabilities: {
        chatTypes: ["group"],
      },
      messaging: {
        normalizeTarget: normalizeTwitchMessagingTarget,
        targetResolver: {
          looksLikeId: (input) => Boolean(normalizeTwitchMessagingTarget(input)),
          hint: "<channel-name>",
        },
        inferTargetChatType: ({ to }) => (normalizeTwitchMessagingTarget(to) ? "group" : undefined),
        resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
          const channel = normalizeTwitchMessagingTarget(target);
          if (!channel) {
            return null;
          }
          return buildChannelOutboundSessionRoute({
            cfg,
            agentId,
            channel: "twitch",
            accountId,
            recipientSessionExact: true,
            peer: { kind: "group", id: channel },
            chatType: "group",
            from: `twitch:channel:${channel}`,
            to: channel,
          });
        },
      },
      message: twitchMessageAdapter,
      configSchema: buildChannelConfigSchema(TwitchConfigSchema),
      config: {
        ...twitchConfigAdapter,
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
          // SAFETY: Gateway startup supplies the full registered runtime behind its context-only public type.
          const channelRuntime = ctx.channelRuntime as PluginRuntime["channel"] | undefined;
          if (!channelRuntime?.inbound?.buildContext) {
            throw new Error("Twitch requires its registered channel runtime context builder");
          }
          const statusSink = createAccountStatusSink({
            accountId,
            setStatus: ctx.setStatus,
          });

          statusSink({
            running: true,
            lastStartAt: Date.now(),
            lastError: null,
            lifecycle: "starting",
          });

          ctx.log?.info(`Starting Twitch connection for ${account.username}`);

          // Keep startAccount pending until abort fires; otherwise the channel
          // supervisor reads the settled task as `channel exited without an
          // error` and triggers a restart loop. See #60071.
          try {
            await runPassiveAccountLifecycle({
              abortSignal: ctx.abortSignal,
              start: async () => {
                // Lazy import: the monitor pulls the reply pipeline; avoid ESM init cycles.
                const { monitorTwitchProvider } = await import("./monitor.js");
                return monitorTwitchProvider({
                  account,
                  accountId,
                  channelRuntime,
                  config: ctx.cfg,
                  runtime: ctx.runtime,
                  abortSignal: ctx.abortSignal,
                  statusSink,
                });
              },
              stop: async (monitor) => {
                await monitor.stop();
              },
            });
          } catch (error) {
            ctx.setStatus?.({
              accountId,
              running: false,
              lastStopAt: Date.now(),
            });
            throw error;
          }
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
