import type { JsonValue } from "./protocol.js";

export type CodexElicitationResponse = {
  action: "accept" | "decline" | "cancel";
  content: JsonValue | null;
  _meta: JsonValue | null;
};

export function createCodexElicitationResponse(
  action: CodexElicitationResponse["action"],
  content: JsonValue | null = null,
  meta: JsonValue | null = null,
): CodexElicitationResponse {
  return { action, content, _meta: meta };
}
