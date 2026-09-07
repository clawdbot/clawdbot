import { parseMentions } from "./mentions.js";

const AI_GENERATED_ENTITY = {
  type: "https://schema.org/Message",
  "@type": "Message",
  "@context": "https://schema.org",
  "@id": "",
  additionalType: ["AIGeneratedContent"],
};

/** Build final transport text and its matching entities after Markdown rendering. */
export function buildMSTeamsMessageActivity(text?: string) {
  const parsed = parseMentions(text ?? "");
  return {
    type: "message" as const,
    ...(text === undefined ? {} : { text: parsed.text }),
    entities: [...parsed.entities, AI_GENERATED_ENTITY],
  };
}
