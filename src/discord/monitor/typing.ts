import type { Client } from "@buape/carbon";

import { logVerbose } from "../../globals.js";

export async function sendTyping(params: {
  client: Client;
  channelId: string;
}) {
  try {
    const channel = await params.client.fetchChannel(params.channelId);
    if (!channel) return;
    if (
      "triggerTyping" in channel &&
      typeof channel.triggerTyping === "function"
    ) {
      await channel.triggerTyping();
    }
  } catch (err) {
    logVerbose(
      `discord typing cue failed for channel ${params.channelId}: ${String(err)}`,
    );
  }
}
