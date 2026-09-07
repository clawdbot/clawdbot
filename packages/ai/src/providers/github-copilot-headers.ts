// GitHub Copilot header helpers build request headers for Copilot-backed providers.
import type { Message } from "../types.js";
import { projectCopilotRequestFacts } from "./github-copilot-request-facts.js";

export function hasCopilotVisionInput(messages: Message[]): boolean {
  return projectCopilotRequestFacts(messages, "direct").hasImages;
}

export function buildCopilotDynamicHeaders(params: {
  messages: Message[];
  hasImages: boolean;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Initiator": projectCopilotRequestFacts(params.messages, "direct", params.hasImages)
      .initiator,
    "Openai-Intent": "conversation-edits",
  };

  if (params.hasImages) {
    headers["Copilot-Vision-Request"] = "true";
  }

  return headers;
}
