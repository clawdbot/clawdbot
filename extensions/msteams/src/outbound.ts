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
import {
  chunkTextForOutbound,
  normalizeStringEntries,
  type ChannelOutboundAdapter,
} from "../runtime-api.js";
import { createMSTeamsPollStoreFs } from "./polls.js";
import { buildMSTeamsPresentationCard, MSTEAMS_PRESENTATION_CAPABILITIES } from "./presentation.js";
import { sendAdaptiveCardMSTeams, sendMessageMSTeams, sendPollMSTeams } from "./send.js";

function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const MSTEAMS_TEXT_CHUNK_LIMIT = 4000;

type MSTeamsSendConfig = Parameters<typeof sendMessageMSTeams>[0]["cfg"];
type MSTeamsSendResult = { messageId: string; conversationId: string };
type MSTeamsMediaSendOptions = {
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
};
type MSTeamsTextSendFn = (to: string, text: string) => Promise<MSTeamsSendResult>;
type MSTeamsMediaSendFn = (
  to: string,
  text: string,
  opts?: MSTeamsMediaSendOptions,
) => Promise<MSTeamsSendResult>;

function resolveMSTeamsTextSend(params: {
  cfg: MSTeamsSendConfig;
  deps?: OutboundSendDeps;
}): MSTeamsTextSendFn {
  return (
    resolveOutboundSendDep<MSTeamsTextSendFn>(params.deps, "msteams") ??
    ((to, text) => sendMessageMSTeams({ cfg: params.cfg, to, text }))
  );
}

function resolveMSTeamsMediaSend(params: {
  cfg: MSTeamsSendConfig;
  deps?: OutboundSendDeps;
}): MSTeamsMediaSendFn {
  return (
    resolveOutboundSendDep<MSTeamsMediaSendFn>(params.deps, "msteams") ??
    ((to, text, opts) =>
      sendMessageMSTeams({
        cfg: params.cfg,
        to,
        text,
        mediaUrl: opts?.mediaUrl,
        mediaLocalRoots: opts?.mediaLocalRoots,
        mediaReadFile: opts?.mediaReadFile,
      }))
  );
}

export const msteamsOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown",
  textChunkLimit: MSTEAMS_TEXT_CHUNK_LIMIT,
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
    const msteamsData = asObjectRecord(payload.channelData?.msteams) ?? {};
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
    mediaLocalRoots,
    mediaReadFile,
    payload,
    deps,
  }) => {
    const msteamsData = asObjectRecord(payload.channelData?.msteams);
    const presentationCard = msteamsData?.presentationCard;
    if (
      presentationCard &&
      typeof presentationCard === "object" &&
      !Array.isArray(presentationCard)
    ) {
      const result = await sendAdaptiveCardMSTeams({
        cfg,
        to,
        card: presentationCard as Record<string, unknown>,
      });
      return attachChannelToResult("msteams", result);
    }
    const mediaUrls = normalizeStringEntries(
      resolvePayloadMediaUrls({
        ...payload,
        mediaUrl: payload.mediaUrl ?? mediaUrl,
      }),
    );
    if (mediaUrls.length > 0) {
      const send = resolveMSTeamsMediaSend({ cfg, deps });
      const result = await sendPayloadMediaSequence({
        text,
        mediaUrls,
        send: async ({ text, mediaUrl }) =>
          await send(to, text, { mediaUrl, mediaLocalRoots, mediaReadFile }),
      });
      if (result) {
        return attachChannelToResult("msteams", result);
      }
    }
    if (text.trim()) {
      const send = resolveMSTeamsTextSend({ cfg, deps });
      const chunks = resolveTextChunksWithFallback(
        text,
        chunkTextForOutbound(text, MSTEAMS_TEXT_CHUNK_LIMIT),
      );
      let result: Awaited<ReturnType<MSTeamsTextSendFn>>;
      for (const chunk of chunks) {
        result = await send(to, chunk);
      }
      return attachChannelToResult("msteams", result!);
    }
    throw new Error("MS Teams payload send requires text, media, or a presentation card.");
  },
  ...createAttachedChannelResultAdapter({
    channel: "msteams",
    sendText: async ({ cfg, to, text, deps }) => {
      const send = resolveMSTeamsTextSend({ cfg, deps });
      return await send(to, text);
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, mediaReadFile, deps }) => {
      const send = resolveMSTeamsMediaSend({ cfg, deps });
      return await send(to, text, { mediaUrl, mediaLocalRoots, mediaReadFile });
    },
    sendPoll: async ({ cfg, to, poll }) => {
      const maxSelections = poll.maxSelections ?? 1;
      const result = await sendPollMSTeams({
        cfg,
        to,
        question: poll.question,
        options: poll.options,
        maxSelections,
      });
      const pollStore = createMSTeamsPollStoreFs();
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
