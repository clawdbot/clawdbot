import { HEARTBEAT_TOKEN } from "./tokens.js";

export const HEARTBEAT_PROMPT = "HEARTBEAT";
export const DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 30;

export type StripHeartbeatMode = "heartbeat" | "message";

function stripTokenAtEdges(raw: string): { text: string; didStrip: boolean } {
  let text = raw.trim();
  if (!text) return { text: "", didStrip: false };

  const token = HEARTBEAT_TOKEN;
  if (!text.includes(token)) return { text, didStrip: false };

  let didStrip = false;
  let changed = true;
  while (changed) {
    changed = false;
    const next = text.trim();
    if (next.startsWith(token)) {
      const after = next.slice(token.length).trimStart();
      text = after;
      didStrip = true;
      changed = true;
      continue;
    }
    if (next.endsWith(token)) {
      const before = next.slice(0, Math.max(0, next.length - token.length));
      text = before.trimEnd();
      didStrip = true;
      changed = true;
    }
  }

  const collapsed = text.replace(/\s+/g, " ").trim();
  return { text: collapsed, didStrip };
}

export function stripHeartbeatToken(
  raw?: string,
  opts: { mode?: StripHeartbeatMode; maxAckChars?: number } = {},
) {
  if (!raw) return { shouldSkip: true, text: "", didStrip: false };
  const trimmed = raw.trim();
  if (!trimmed) return { shouldSkip: true, text: "", didStrip: false };

  const mode: StripHeartbeatMode = opts.mode ?? "message";
  const maxAckChars = Math.max(
    0,
    opts.maxAckChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  );

  if (!trimmed.includes(HEARTBEAT_TOKEN)) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }

  const stripped = stripTokenAtEdges(trimmed);
  if (!stripped.didStrip) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }

  if (!stripped.text) {
    return { shouldSkip: true, text: "", didStrip: true };
  }

  if (mode === "heartbeat") {
    const rest = stripped.text.trim();
    if (rest.length <= maxAckChars) {
      return { shouldSkip: true, text: "", didStrip: true };
    }
  }

  return { shouldSkip: false, text: stripped.text, didStrip: true };
}
