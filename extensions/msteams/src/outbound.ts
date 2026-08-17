// Msteams plugin module implements outbound behavior.
import {
  resolveOutboundSendDep,
  type OutboundSendDeps,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import {
  resolvePayloadMediaUrls,
  resolveTextChunksWithFallback,
  sendPayloadMediaSequence,
} from "openclaw/plugin-sdk/reply-payload";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  chunkTextForOutbound,
  normalizeStringEntries,
  type ChannelOutboundAdapter,
} from "../runtime-api.js";
import { resolveDefaultMSTeamsAccountId, resolveMSTeamsAccountConfig } from "./accounts.js";
import { formatUnknownError } from "./errors.js";
import { createMSTeamsPollStoreState } from "./polls.js";
import { buildMSTeamsPresentationCard, MSTEAMS_PRESENTATION_CAPABILITIES } from "./presentation.js";
import { getMSTeamsRuntime } from "./runtime.js";
import { sendAdaptiveCardMSTeams, sendMessageMSTeams, sendPollMSTeams } from "./send.js";

const MSTEAMS_TEXT_CHUNK_LIMIT = 4000;

function resolveMSTeamsEffectiveTextChunkLimit(configuredLimit?: number): number {
  return typeof configuredLimit === "number" && configuredLimit > 0
    ? Math.min(configuredLimit, MSTEAMS_TEXT_CHUNK_LIMIT)
    : MSTEAMS_TEXT_CHUNK_LIMIT;
}

type MSTeamsSendConfig = Parameters<typeof sendMessageMSTeams>[0]["cfg"];
type MSTeamsSendResult = { messageId: string; conversationId: string };
type MSTeamsMediaSendOptions = Pick<
  Parameters<typeof sendMessageMSTeams>[0],
  "mediaUrl" | "mediaAccess" | "mediaLocalRoots" | "mediaReadFile"
> & {
  cfg?: MSTeamsSendConfig;
  accountId?: string | null;
};
type MSTeamsTextSendOptions = {
  cfg: MSTeamsSendConfig;
  accountId?: string | null;
};
type MSTeamsTextSendFn = (
  to: string,
  text: string,
  opts?: MSTeamsTextSendOptions,
) => Promise<MSTeamsSendResult>;
type MSTeamsMediaSendFn = (
  to: string,
  text: string,
  opts?: MSTeamsMediaSendOptions,
) => Promise<MSTeamsSendResult>;

function logMSTeamsOutboundFailure(params: {
  kind: string;
  to: string;
  accountId?: string | null;
  error: unknown;
}): void {
  getMSTeamsRuntime()
    .logging.getChildLogger({ name: "msteams:outbound" })
    .warn?.(`${params.kind} failed`, {
      to: params.to,
      ...(params.accountId ? { accountId: params.accountId } : {}),
      error: formatUnknownError(params.error),
    });
}

function toMSTeamsOutboundResult(result: MSTeamsSendResult) {
  const { conversationId, ...delivery } = result;
  return { ...delivery, target: { kind: "conversation" as const, id: conversationId } };
}

function resolveMSTeamsThreadTarget(to: string, threadId?: string | number | null) {
  const normalizedThreadId = threadId == null ? "" : String(threadId).trim();
  const graphChannelId = to.includes("/") ? to.slice(to.indexOf("/") + 1) : "";
  const isConversationTarget =
    to.startsWith("conversation:") ||
    to.startsWith("19:") ||
    graphChannelId.startsWith("19:") ||
    graphChannelId.includes("@thread");
  // Keep the resolved root on the target so proactive lookup and Connector
  // delivery use this turn's thread, not the latest stored conversation root.
  if (!normalizedThreadId || /(?:^|;)messageid=/iu.test(to) || !isConversationTarget) {
    return to;
  }
  return `${to};messageid=${normalizedThreadId}`;
}

function resolveMSTeamsTextSend(params: {
  cfg: MSTeamsSendConfig;
  accountId?: string | null;
  deps?: OutboundSendDeps;
}): MSTeamsTextSendFn {
  const injected = resolveOutboundSendDep<MSTeamsTextSendFn>(params.deps, "msteams");
  if (injected) {
    return async (to, text) =>
      await injected(to, text, {
        cfg: params.cfg,
        ...(params.accountId ? { accountId: params.accountId } : {}),
      });
  }
  return (to, text) =>
    sendMessageMSTeams({
      cfg: params.cfg,
      ...(params.accountId ? { accountId: params.accountId } : {}),
      to,
      text,
    });
}

function resolveMSTeamsMediaSend(params: {
  cfg: MSTeamsSendConfig;
  accountId?: string | null;
  deps?: OutboundSendDeps;
}): MSTeamsMediaSendFn {
  const injected = resolveOutboundSendDep<MSTeamsMediaSendFn>(params.deps, "msteams");
  if (injected) {
    return async (to, text, opts) =>
      await injected(to, text, {
        ...opts,
        cfg: params.cfg,
        ...(params.accountId ? { accountId: params.accountId } : {}),
      });
  }
  return (to, text, opts) =>
    sendMessageMSTeams({
      cfg: params.cfg,
      ...(params.accountId ? { accountId: params.accountId } : {}),
      to,
      text,
      mediaUrl: opts?.mediaUrl,
      mediaAccess: opts?.mediaAccess,
      mediaLocalRoots: opts?.mediaLocalRoots,
      mediaReadFile: opts?.mediaReadFile,
    });
}

export const msteamsOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown",
  textChunkLimit: MSTEAMS_TEXT_CHUNK_LIMIT,
  resolveEffectiveTextChunkLimit: ({ fallbackLimit }) =>
    resolveMSTeamsEffectiveTextChunkLimit(fallbackLimit),
  pollMaxOptions: 12,
  deliveryCapabilities: {
    durableFinal: {
      text: true,
      media: true,
      payload: true,
      messageSendingHooks: true,
    },
  },
  presentationCapabilities: MSTEAMS_PRESENTATION_CAPABILITIES,
  renderPresentation: ({ payload, presentation }) => {
    if (payload.mediaUrl || payload.mediaUrls?.length) {
      return null;
    }
    const card = buildMSTeamsPresentationCard({
      presentation,
      text: payload.text,
    });
    const msteamsData = asOptionalRecord(payload.channelData?.msteams) ?? {};
    return {
      ...payload,
      channelData: {
        ...payload.channelData,
        msteams: {
          ...msteamsData,
          presentationCard: card,
        },
      },
    };
  },
  sendPayload: async ({
    cfg,
    to,
    text,
    mediaUrl,
    mediaAccess,
    mediaLocalRoots,
    mediaReadFile,
    payload,
    accountId,
    deps,
    onDeliveryResult,
    threadId,
  }) => {
    try {
      const deliveryTarget = resolveMSTeamsThreadTarget(to, threadId);
      const msteamsData = asOptionalRecord(payload.channelData?.msteams);
      const presentationCard = msteamsData?.presentationCard;
      if (
        presentationCard &&
        typeof presentationCard === "object" &&
        !Array.isArray(presentationCard)
      ) {
        const result = await sendAdaptiveCardMSTeams({
          cfg,
          ...(accountId ? { accountId } : {}),
          to: deliveryTarget,
          card: presentationCard as Record<string, unknown>,
        });
        return attachChannelToResult("msteams", toMSTeamsOutboundResult(result));
      }
      const mediaUrls = normalizeStringEntries(
        resolvePayloadMediaUrls({
          ...payload,
          mediaUrl: payload.mediaUrl ?? mediaUrl,
        }),
      );
      if (mediaUrls.length > 0) {
        const send = resolveMSTeamsMediaSend({ cfg, accountId, deps });
        const result = await sendPayloadMediaSequence<MSTeamsSendResult>({
          text,
          mediaUrls,
          onResult: async (deliveryResult) => {
            await onDeliveryResult?.(
              attachChannelToResult("msteams", toMSTeamsOutboundResult(deliveryResult)),
            );
          },
          send: async ({ text: textLocal, mediaUrl: mediaUrlLocal }) =>
            await send(deliveryTarget, textLocal, {
              mediaUrl: mediaUrlLocal,
              mediaAccess,
              mediaLocalRoots,
              mediaReadFile,
            }),
        });
        if (result) {
          return attachChannelToResult("msteams", toMSTeamsOutboundResult(result));
        }
      }
      if (text.trim()) {
        const send = resolveMSTeamsTextSend({ cfg, accountId, deps });
        const msteamsCfg = resolveMSTeamsAccountConfig(cfg, accountId);
        const chunks = resolveTextChunksWithFallback(
          text,
          chunkTextForOutbound(
            text,
            resolveMSTeamsEffectiveTextChunkLimit(msteamsCfg.textChunkLimit),
          ),
        );
        let result: Awaited<ReturnType<MSTeamsTextSendFn>>;
        for (const chunk of chunks) {
          result = await send(deliveryTarget, chunk);
          await onDeliveryResult?.(
            attachChannelToResult("msteams", toMSTeamsOutboundResult(result)),
          );
        }
        return attachChannelToResult("msteams", toMSTeamsOutboundResult(result!));
      }
      throw new Error("MS Teams payload send requires text, media, or a presentation card.");
    } catch (error) {
      logMSTeamsOutboundFailure({
        kind: "payload send",
        to,
        accountId,
        error,
      });
      throw error;
    }
  },
  ...createAttachedChannelResultAdapter({
    channel: "msteams",
    sendText: async ({ cfg, to, text, accountId, deps, threadId }) => {
      try {
        const send = resolveMSTeamsTextSend({ cfg, accountId, deps });
        return toMSTeamsOutboundResult(await send(resolveMSTeamsThreadTarget(to, threadId), text));
      } catch (error) {
        logMSTeamsOutboundFailure({
          kind: "text send",
          to,
          accountId,
          error,
        });
        throw error;
      }
    },
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
      accountId,
      deps,
      threadId,
    }) => {
      try {
        const send = resolveMSTeamsMediaSend({ cfg, accountId, deps });
        return toMSTeamsOutboundResult(
          await send(resolveMSTeamsThreadTarget(to, threadId), text, {
            mediaUrl,
            mediaAccess,
            mediaLocalRoots,
            mediaReadFile,
          }),
        );
      } catch (error) {
        logMSTeamsOutboundFailure({
          kind: "media send",
          to,
          accountId,
          error,
        });
        throw error;
      }
    },
    sendPoll: async ({ cfg, to, poll, accountId, threadId }) => {
      const effectiveAccountId = accountId ?? resolveDefaultMSTeamsAccountId(cfg);
      const maxSelections = poll.maxSelections ?? 1;
      const result = await sendPollMSTeams({
        cfg,
        accountId: effectiveAccountId,
        to: resolveMSTeamsThreadTarget(to, threadId),
        question: poll.question,
        options: poll.options,
        maxSelections,
      });
      const pollStore = createMSTeamsPollStoreState({ accountId: effectiveAccountId });
      await pollStore.createPoll({
        id: result.pollId,
        question: poll.question,
        options: poll.options,
        maxSelections,
        createdAt: new Date().toISOString(),
        conversationId: result.conversationId,
        messageId: result.messageId,
        votes: {},
      });
      return result;
    },
  }),
};
