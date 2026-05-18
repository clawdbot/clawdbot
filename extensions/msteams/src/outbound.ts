import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import { resolveOutboundSendDep } from "openclaw/plugin-sdk/outbound-send-deps";
import {
  resolvePayloadMediaUrls,
  resolveTextChunksWithFallback,
  sendPayloadMediaSequence,
} from "openclaw/plugin-sdk/reply-payload";
import { chunkTextForOutbound, type ChannelOutboundAdapter } from "../runtime-api.js";
import { createMSTeamsPollStoreFs } from "./polls.js";
import { buildMSTeamsPresentationCard, MSTEAMS_PRESENTATION_CAPABILITIES } from "./presentation.js";
import { sendAdaptiveCardMSTeams, sendMessageMSTeams, sendPollMSTeams } from "./send.js";

function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const MSTEAMS_TEXT_CHUNK_LIMIT = 4000;

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
    const mediaUrls = resolvePayloadMediaUrls({
      ...payload,
      mediaUrl: payload.mediaUrl ?? mediaUrl,
    })
      .map((url) => url.trim())
      .filter(Boolean);
    if (mediaUrls.length > 0) {
      type SendFn = (
        to: string,
        text: string,
        opts?: {
          mediaUrl?: string;
          mediaLocalRoots?: readonly string[];
          mediaReadFile?: (filePath: string) => Promise<Buffer>;
        },
      ) => Promise<{ messageId: string; conversationId: string }>;
      const send =
        resolveOutboundSendDep<SendFn>(deps, "msteams") ??
        ((to, text, opts) =>
          sendMessageMSTeams({
            cfg,
            to,
            text,
            mediaUrl: opts?.mediaUrl,
            mediaLocalRoots: opts?.mediaLocalRoots,
            mediaReadFile: opts?.mediaReadFile,
          }));
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
      type SendFn = (
        to: string,
        text: string,
      ) => Promise<{ messageId: string; conversationId: string }>;
      const send =
        resolveOutboundSendDep<SendFn>(deps, "msteams") ??
        ((to, text) => sendMessageMSTeams({ cfg, to, text }));
      const chunks = resolveTextChunksWithFallback(
        text,
        chunkTextForOutbound(text, MSTEAMS_TEXT_CHUNK_LIMIT),
      );
      let result: Awaited<ReturnType<SendFn>>;
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
      type SendFn = (
        to: string,
        text: string,
      ) => Promise<{ messageId: string; conversationId: string }>;
      const send =
        resolveOutboundSendDep<SendFn>(deps, "msteams") ??
        ((to, text) => sendMessageMSTeams({ cfg, to, text }));
      return await send(to, text);
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, mediaReadFile, deps }) => {
      type SendFn = (
        to: string,
        text: string,
        opts?: {
          mediaUrl?: string;
          mediaLocalRoots?: readonly string[];
          mediaReadFile?: (filePath: string) => Promise<Buffer>;
        },
      ) => Promise<{ messageId: string; conversationId: string }>;
      const send =
        resolveOutboundSendDep<SendFn>(deps, "msteams") ??
        ((to, text, opts) =>
          sendMessageMSTeams({
            cfg,
            to,
            text,
            mediaUrl: opts?.mediaUrl,
            mediaLocalRoots: opts?.mediaLocalRoots,
            mediaReadFile: opts?.mediaReadFile,
          }));
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
