import type { ChannelOutboundAdapter } from "clawdbot/plugin-sdk";

import { createMSTeamsPollStoreFs } from "./polls.js";
import { getMSTeamsRuntime } from "./runtime.js";
import { sendMessageMSTeams, sendPollMSTeams } from "./send.js";

export const msteamsOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getMSTeamsRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  pollMaxOptions: 12,
  sendText: async ({ cfg, to, text, deps }) => {
    const send = deps?.sendMSTeams ?? ((to, text) => sendMessageMSTeams({ cfg, to, text }));
    const result = await send(to, text);
    return { channel: "msteams", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, deps }) => {
    const send =
      deps?.sendMSTeams ??
      ((to, text, opts) => sendMessageMSTeams({ cfg, to, text, mediaUrl: opts?.mediaUrl }));
    const result = await send(to, text, { mediaUrl });
    return { channel: "msteams", ...result };
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
};
