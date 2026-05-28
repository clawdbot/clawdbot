import type { Message } from "../types.js";

// Copilot expects X-Initiator to indicate whether the request is user-initiated
// or agent-initiated (e.g. follow-up after assistant/tool messages).
export function inferCopilotInitiator(messages: Message[]): "user" | "agent" {
  const last = messages[messages.length - 1];
  return last && last.role !== "user" ? "agent" : "user";
}

// Copilot requires Copilot-Vision-Request header when sending images
export function hasCopilotVisionInput(messages: Message[]): boolean {
  return messages.some((msg) => {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      return msg.content.some((c) => c.type === "image");
    }
    if (msg.role === "toolResult" && Array.isArray(msg.content)) {
      return msg.content.some((c) => c.type === "image");
    }
    return false;
  });
}

export function buildCopilotDynamicHeaders(params: {
  messages: Message[];
  hasImages: boolean;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Initiator": inferCopilotInitiator(params.messages),
    "Openai-Intent": "conversation-edits",
  };

  if (params.hasImages) {
    headers["Copilot-Vision-Request"] = "true";
  }

  return headers;
}
