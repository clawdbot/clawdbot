export type GatewayTranscriptMessage = {
  role?: unknown;
  content?: unknown;
};

export type GatewayChatContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
};

export type ReplayChunk = {
  sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk";
  text: string;
};

export function extractReplayChunks(message: GatewayTranscriptMessage): ReplayChunk[] {
  const role = typeof message.role === "string" ? message.role : "";
  if (role !== "user" && role !== "assistant") {
    return [];
  }
  if (typeof message.content === "string") {
    return message.content.length > 0
      ? [
          {
            sessionUpdate: role === "user" ? "user_message_chunk" : "agent_message_chunk",
            text: message.content,
          },
        ]
      : [];
  }
  if (!Array.isArray(message.content)) {
    return [];
  }

  const replayChunks: ReplayChunk[] = [];
  for (const block of message.content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      continue;
    }
    const typedBlock = block as GatewayChatContentBlock;
    if (typedBlock.type === "text" && typeof typedBlock.text === "string" && typedBlock.text) {
      replayChunks.push({
        sessionUpdate: role === "user" ? "user_message_chunk" : "agent_message_chunk",
        text: typedBlock.text,
      });
      continue;
    }
    if (
      role === "assistant" &&
      typedBlock.type === "thinking" &&
      typeof typedBlock.thinking === "string" &&
      typedBlock.thinking
    ) {
      replayChunks.push({
        sessionUpdate: "agent_thought_chunk",
        text: typedBlock.thinking,
      });
    }
  }
  return replayChunks;
}
