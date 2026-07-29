// Github Copilot plugin module implements connection bound ids behavior.
import { createHash } from "node:crypto";

// Copilot's OpenAI-compatible `/responses` endpoint can emit replay item IDs
// that encode upstream connection state. Those IDs are rejected after the
// connection changes, so sanitize them at the provider boundary before send.

function looksLikeConnectionBoundId(id: string): boolean {
  if (id.length < 24) {
    return false;
  }
  if (/^(?:rs|msg|fc)_[A-Za-z0-9_-]+$/.test(id)) {
    return false;
  }
  if (!/^[A-Za-z0-9+/_-]+=*$/.test(id)) {
    return false;
  }
  return Buffer.from(id, "base64").length >= 16;
}

function deriveReplacementId(type: string | undefined, originalId: string): string {
  const prefix = type === "function_call" ? "fc" : "msg";
  const hex = createHash("sha256").update(originalId).digest("hex").slice(0, 16);
  return `${prefix}_${hex}`;
}

type InputItem = Record<string, unknown> & { id?: unknown; type?: unknown };

function isInputItem(value: unknown): value is InputItem {
  return Boolean(value) && typeof value === "object";
}

function isValidReasoningReplayId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 64;
}

function sanitizeCopilotReplayResponseIds(input: unknown): boolean {
  if (!Array.isArray(input)) {
    return false;
  }
  let rewrote = false;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!isInputItem(item)) {
      continue;
    }
    const id = item.id;
    // Reasoning encrypted_content is tied to the Copilot connection token,
    // which rotates per request. Drop items with unsafe IDs; strip
    // encrypted_content from kept items so summary-only replay is sent.
    if (item.type === "reasoning") {
      if (id !== undefined && !isValidReasoningReplayId(id)) {
        input.splice(index, 1);
        rewrote = true;
      } else if ("encrypted_content" in item) {
        delete item.encrypted_content;
        rewrote = true;
      }
      continue;
    }
    if (typeof id !== "string" || id.length === 0) {
      continue;
    }
    if (looksLikeConnectionBoundId(id)) {
      item.id = deriveReplacementId(typeof item.type === "string" ? item.type : undefined, id);
      rewrote = true;
    }
  }
  return rewrote;
}

export function sanitizeCopilotReplayResponsePayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  return sanitizeCopilotReplayResponseIds((payload as { input?: unknown }).input);
}
