import { createAttachedChannelResultAdapter } from "openclaw/plugin-sdk/channel-send-result";
import { resolveOutboundSendDep } from "openclaw/plugin-sdk/outbound-runtime";
import { chunkTextForOutbound, type ChannelOutboundAdapter } from "../runtime-api.js";
import { createMSTeamsPollStoreFs } from "./polls.js";
import { sendMessageMSTeams, sendPollMSTeams } from "./send.js";

export const msteamsOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  pollMaxOptions: 12,
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
