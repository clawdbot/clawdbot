import crypto from "node:crypto";

const RESEED_HEADER = [
  "Continue this conversation using the OpenClaw transcript below as prior session history.",
  "Treat it as authoritative context for this fresh CLI session.",
  "",
  "<conversation_history>",
].join("\n");
const RESEED_PREFIX = `${RESEED_HEADER}\n`;
const RESEED_USER_BOUNDARY = "\n</conversation_history>\n\n<next_user_message>\n";
const RESEED_USER_CLOSE = "\n</next_user_message>";

type ParsedCliReseedPrompt =
  | { kind: "none" }
  | { kind: "legacy"; userMessage: string }
  | { kind: "invalid" };

export function hashCliReseedPrompt(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function parseCliReseedPrompt(text: string): ParsedCliReseedPrompt {
  if (!text.startsWith(RESEED_PREFIX)) {
    return text.startsWith(RESEED_HEADER) ? { kind: "invalid" } : { kind: "none" };
  }
  const boundaryIndex = text.indexOf(RESEED_USER_BOUNDARY);
  if (boundaryIndex !== text.lastIndexOf(RESEED_USER_BOUNDARY)) {
    return { kind: "invalid" };
  }
  if (boundaryIndex <= RESEED_PREFIX.length) {
    return { kind: "invalid" };
  }
  const promptStart = boundaryIndex + RESEED_USER_BOUNDARY.length;
  const closeIndex = text.lastIndexOf(RESEED_USER_CLOSE);
  if (closeIndex < promptStart) {
    return { kind: "invalid" };
  }
  return {
    kind: "legacy",
    userMessage: text.slice(promptStart, closeIndex),
  };
}
