import type { Message } from "../../llm/types.js";

// A leaf keeps observer/decision imports acyclic and the decision unit tests lightweight.
export function readExperienceReviewMessageText(content: Message["content"]): string {
  return typeof content === "string"
    ? content
    : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}
