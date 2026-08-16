import { markdownToIR } from "../../../packages/markdown-core/src/ir.js";

type AssistantTranscriptRoleHeaderDetection = {
  kind: "angle_role_header" | "role_timestamp_bracket" | "timestamp_role_colon";
  role: "assistant" | "developer" | "system" | "user";
};

/** Detect transcript-role headers in assistant Markdown through the canonical parser. */
export function detectAssistantTranscriptRoleHeaderText(
  text: string,
): AssistantTranscriptRoleHeaderDetection | null {
  const annotation = markdownToIR(text, {
    assistantTranscriptRoleHeaders: true,
    enableSpoilers: true,
    linkify: false,
    tableMode: "off",
  }).annotations?.[0];
  if (!annotation || annotation.type !== "assistant_transcript_role") {
    return null;
  }
  return { kind: annotation.kind, role: annotation.role };
}
