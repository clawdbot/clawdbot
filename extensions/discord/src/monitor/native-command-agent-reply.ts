// Discord plugin module implements native command agent reply behavior.
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  hasVisibleInboundReplyDispatch,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveChannelStreamingBlockEnabled } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import {
  PLUGIN_COMMAND_DISPATCH,
  type PluginCommandCatalogDecision,
} from "openclaw/plugin-sdk/plugin-command-runtime";
import { resolveChunkMode, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import type { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveDiscordMaxLinesPerMessage } from "../accounts.js";
import type {
  ButtonInteraction,
  CommandInteraction,
  StringSelectMenuInteraction,
} from "../internal/discord.js";
import type { DiscordChannelConfigResolved } from "./allow-list.js";
import type { buildDiscordNativeCommandContext } from "./native-command-context.js";
import {
  DISCORD_EMPTY_VISIBLE_REPLY_WARNING,
  deliverDiscordInteractionReply,
  safeDiscordInteractionCall,
  settleDiscordInteractionWithoutVisibleReply,
} from "./native-command-reply.js";
import { nativeCommandRuntime } from "./native-command.runtime.js";
import type { DiscordConfig, DiscordDispatchReplyFromConfig } from "./native-command.types.js";

type NativeCommandEffectiveRoute = {
  accountId: string;
  agentId: string;
  sessionKey: string;
};

type DispatchDiscordNativeAgentReplyResult = {
  dispatched: boolean;
  hiddenFinalReply?: ReplyPayload;
};

export async function dispatchDiscordNativeAgentReply(params: {
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  accountId: string;
  interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
  ctxPayload: ReturnType<typeof buildDiscordNativeCommandContext>;
  effectiveRoute: NativeCommandEffectiveRoute;
  channelConfig: DiscordChannelConfigResolved | null;
  mediaLocalRoots: ReturnType<typeof getAgentScopedMediaLocalRoots>;
  preferFollowUp: boolean;
  responseEphemeral?: boolean;
  suppressReplies?: boolean;
  dispatchReplyFromConfig?: DiscordDispatchReplyFromConfig;
  log: ReturnType<typeof createSubsystemLogger>;
  pluginCommandDispatch: PluginCommandCatalogDecision;
}): Promise<DispatchDiscordNativeAgentReplyResult> {
  const blockStreamingEnabled = resolveChannelStreamingBlockEnabled(params.discordConfig);

  let didReply = false;
  let finalReplyOutcome: "accepted" | "failed" | "suppressed" | undefined;
  let hiddenFinalReply: ReplyPayload | undefined;
  const turnResult = await nativeCommandRuntime.dispatchChannelInboundTurn({
    cfg: params.cfg,
    channel: "discord",
    accountId: params.effectiveRoute.accountId,
    route: {
      agentId: params.effectiveRoute.agentId,
      sessionKey: params.ctxPayload.SessionKey ?? params.effectiveRoute.sessionKey,
    },
    ctxPayload: params.ctxPayload,
    dispatchReplyFromConfig: params.dispatchReplyFromConfig,
    delivery: {
      deliver: async (payload) => {
        if (params.suppressReplies) {
          return {
            visibleReplySent: false,
            suppression: { reason: "no_visible_result" as const },
          };
        }
        const payloadDelivered = await deliverDiscordInteractionReply({
          interaction: params.interaction,
          payload,
          mediaLocalRoots: params.mediaLocalRoots,
          textLimit: resolveTextChunkLimit(params.cfg, "discord", params.accountId, {
            fallbackLimit: 2000,
          }),
          maxLinesPerMessage: resolveDiscordMaxLinesPerMessage({
            cfg: params.cfg,
            discordConfig: params.discordConfig,
            accountId: params.accountId,
          }),
          preferFollowUp: params.preferFollowUp || didReply,
          responseEphemeral: params.responseEphemeral,
          chunkMode: resolveChunkMode(params.cfg, "discord", params.accountId),
        });
        didReply ||= payloadDelivered;
        return payloadDelivered
          ? { visibleReplySent: true }
          : {
              visibleReplySent: false,
              suppression: { reason: "no_visible_result" as const },
            };
      },
      onDelivered: (payload, info, result) => {
        // Hidden picker dispatch reuses only a real core final suppressed by this adapter.
        if (
          params.suppressReplies &&
          info.kind === "final" &&
          result?.suppression?.reason === "no_visible_result" &&
          payload.text?.trim()
        ) {
          hiddenFinalReply = payload;
        }
        // A failed final outweighs later suppression until Discord accepts a final.
        if (
          info.kind === "final" &&
          result?.visibleReplySent !== undefined &&
          (result.visibleReplySent || finalReplyOutcome !== "failed")
        ) {
          finalReplyOutcome = result.visibleReplySent ? "accepted" : "suppressed";
        }
      },
      onError: (err, info) => {
        const partialDelivery = isChannelPartialDeliveryError(err);
        if (partialDelivery) {
          // Preserve failed delivery accounting while preventing an empty fallback from
          // obscuring the prefix that Discord already accepted for this payload.
          didReply = true;
          logVerbose("discord: interaction reply partially delivered before expiry");
        }
        if (info.kind === "final") {
          finalReplyOutcome = partialDelivery ? "accepted" : "failed";
        }
        const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
        params.log.error(`discord slash ${info.kind} reply failed: ${message}`);
      },
    },
    replyPipeline: {},
    dispatcherOptions: {
      humanDelay: resolveHumanDelayConfig(params.cfg, params.effectiveRoute.agentId),
    },
    replyOptions: {
      skillFilter: params.channelConfig?.skills,
      [PLUGIN_COMMAND_DISPATCH]: params.pluginCommandDispatch,
      disableBlockStreaming:
        typeof blockStreamingEnabled === "boolean" ? !blockStreamingEnabled : undefined,
    },
  });
  const deliberateSilentTerminalReply =
    turnResult.dispatched && turnResult.dispatchResult.deliberateSilentTerminalReply === true;
  const dispatchResult = {
    dispatched: turnResult.dispatched,
    ...(hiddenFinalReply ? { hiddenFinalReply } : {}),
  };

  if (
    !didReply &&
    (params.suppressReplies || finalReplyOutcome === "suppressed" || deliberateSilentTerminalReply)
  ) {
    await settleDiscordInteractionWithoutVisibleReply(params.interaction);
    return dispatchResult;
  }
  if (
    didReply ||
    (turnResult.dispatched && hasVisibleInboundReplyDispatch(turnResult.dispatchResult))
  ) {
    return dispatchResult;
  }

  await safeDiscordInteractionCall("interaction empty fallback", async () => {
    const payload = {
      content: DISCORD_EMPTY_VISIBLE_REPLY_WARNING,
      ephemeral: true,
    };
    if (params.preferFollowUp) {
      await params.interaction.followUp(payload);
      return;
    }
    await params.interaction.reply(payload);
  });
  return dispatchResult;
}
