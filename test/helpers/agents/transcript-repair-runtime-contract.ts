import type { AgentMessage } from "@mariozechner/pi-agent-core";

export const QUEUED_USER_MESSAGE_MARKER =
  "[Queued user message that arrived while the previous turn was still active]";

export function textOrphanLeaf(text = "older active-turn message"): { content: string } {
  return { content: text };
}

export function structuredOrphanLeaf(): { content: unknown[] } {
  return {
    content: [
      { type: "text", text: "please inspect this" },
      { type: "image_url", image_url: { url: "https://example.test/cat.png" } },
      { type: "input_audio", audio_url: "https://example.test/cat.wav" },
    ],
  };
}

export function inlineDataUriOrphanLeaf(): { content: unknown[] } {
  return {
    content: [
      { type: "text", text: "please inspect this inline image" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${"a".repeat(4096)}` } },
    ],
  };
}

export function mediaOnlyHistoryMessage(): AgentMessage {
  return {
    role: "user",
    content: [{ type: "image", data: "b".repeat(2048), mimeType: "image/png" }],
    timestamp: 1,
  } as AgentMessage;
}

export function structuredHistoryMessage(): AgentMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: "older structured context" },
      { type: "image", data: "c".repeat(64), mimeType: "image/png" },
    ],
    timestamp: 1,
  } as AgentMessage;
}

export function currentPromptHistoryMessage(prompt: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: 2,
  } as AgentMessage;
}

export function assistantHistoryMessage(text = "ack"): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 2,
  } as AgentMessage;
}
