import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";

const pluginId = "qa-whatsapp-poll-vote-proof";

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function optionalDigest(value) {
  return value ? digest(value) : undefined;
}

export default {
  id: pluginId,
  register(api) {
    const outputPath =
      typeof api.pluginConfig?.outputPath === "string" ? api.pluginConfig.outputPath : undefined;
    if (!outputPath) {
      throw new Error(`${pluginId} requires outputPath`);
    }
    api.on("poll_vote_received", async (event, context) => {
      const record = {
        event: "poll_vote_received",
        observedAt: new Date().toISOString(),
        pollMessageId: digest(event.pollMessageId),
        chatJid: digest(event.chatJid),
        voter: digest(event.voter),
        selectedOptions: event.selectedOptions,
        timestamp: event.timestamp,
        context: {
          channelId: optionalDigest(context.channelId),
          accountId: optionalDigest(context.accountId),
          conversationId: optionalDigest(context.conversationId),
          senderId: optionalDigest(context.senderId),
          messageId: optionalDigest(context.messageId),
        },
      };
      await appendFile(outputPath, `${JSON.stringify(record)}\n`, "utf8");
    });
  },
};
