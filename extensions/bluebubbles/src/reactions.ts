import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { createBlueBubblesClient } from "./client.js";
import { getCachedBlueBubblesPrivateApiStatus } from "./probe.js";
import type { OpenClawConfig } from "./runtime-api.js";

export type BlueBubblesReactionOpts = {
  serverUrl?: string;
  password?: string;
  accountId?: string;
  timeoutMs?: number;
  cfg?: OpenClawConfig;
};

const REACTION_TYPES = new Set(["love", "like", "dislike", "laugh", "emphasize", "question"]);

const REACTION_ALIASES = new Map<string, string>([
  // General
  ["heart", "love"],
  ["love", "love"],
  ["❤", "love"],
  ["❤️", "love"],
  ["red_heart", "love"],
  ["thumbs_up", "like"],
  ["thumbsup", "like"],
  ["thumbs-up", "like"],
  ["thumbsup", "like"],
  ["like", "like"],
  ["thumb", "like"],
  ["ok", "like"],
  ["thumbs_down", "dislike"],
  ["thumbsdown", "dislike"],
  ["thumbs-down", "dislike"],
  ["dislike", "dislike"],
  ["boo", "dislike"],
  ["no", "dislike"],
  // Laugh
  ["haha", "laugh"],
  ["lol", "laugh"],
  ["lmao", "laugh"],
  ["rofl", "laugh"],
  ["😂", "laugh"],
  ["🤣", "laugh"],
  ["xd", "laugh"],
  ["laugh", "laugh"],
  // Emphasize / exclaim
  ["emphasis", "emphasize"],
  ["emphasize", "emphasize"],
  ["exclaim", "emphasize"],
  ["!!", "emphasize"],
  ["‼", "emphasize"],
  ["‼️", "emphasize"],
  ["❗", "emphasize"],
  ["important", "emphasize"],
  ["bang", "emphasize"],
  // Question
  ["question", "question"],
  ["?", "question"],
  ["❓", "question"],
  ["❔", "question"],
  ["ask", "question"],
  // Apple/Messages names
  ["loved", "love"],
  ["liked", "like"],
  ["disliked", "dislike"],
  ["laughed", "laugh"],
  ["emphasized", "emphasize"],
  ["questioned", "question"],
  // Colloquial / informal
  ["fire", "love"],
  ["🔥", "love"],
  ["wow", "emphasize"],
  ["!", "emphasize"],
  // Edge: generic emoji name forms
  ["heart_eyes", "love"],
  ["smile", "laugh"],
  ["smiley", "laugh"],
  ["happy", "laugh"],
  ["joy", "laugh"],
]);

const REACTION_EMOJIS = new Map<string, string>([
  // Love
  ["❤️", "love"],
  ["❤", "love"],
  ["♥️", "love"],
  ["♥", "love"],
  ["😍", "love"],
  ["💕", "love"],
  // Like
  ["👍", "like"],
  ["👌", "like"],
  // Dislike
  ["👎", "dislike"],
  ["🙅", "dislike"],
  // Laugh
  ["😂", "laugh"],
  ["🤣", "laugh"],
  ["😆", "laugh"],
  ["😁", "laugh"],
  ["😹", "laugh"],
  // Emphasize
  ["‼️", "emphasize"],
  ["‼", "emphasize"],
  ["!!", "emphasize"],
  ["❗", "emphasize"],
  ["❕", "emphasize"],
  ["!", "emphasize"],
  // Question
  ["❓", "question"],
  ["❔", "question"],
  ["?", "question"],
]);

const UNSUPPORTED_REACTION_ERROR = "UnsupportedBlueBubblesReaction";

/**
 * Strict normalizer: throws when the input does not map to a supported
 * BlueBubbles reaction type. Use this for validator-style callers that
 * need to detect unsupported input (e.g. config sanity checks) rather
 * than gracefully substituting a fallback.
 */
export function normalizeBlueBubblesReactionInputStrict(
  emoji: string,
  remove?: boolean,
): string {
  const trimmed = emoji.trim();
  if (!trimmed) {
    throw new Error("BlueBubbles reaction requires an emoji or name.");
  }
  let raw = normalizeLowercaseStringOrEmpty(trimmed);
  if (raw.startsWith("-")) {
    raw = raw.slice(1);
  }
  const aliased = REACTION_ALIASES.get(raw) ?? raw;
  const mapped = REACTION_EMOJIS.get(trimmed) ?? REACTION_EMOJIS.get(raw) ?? aliased;
  if (!REACTION_TYPES.has(mapped)) {
    const error = new Error(`Unsupported BlueBubbles reaction: ${trimmed}`);
    error.name = UNSUPPORTED_REACTION_ERROR;
    throw error;
  }
  return remove ? `-${mapped}` : mapped;
}

/**
 * Lenient normalizer: when the input does not map to a supported
 * BlueBubbles reaction type (iMessage tapback only supports
 * love/like/dislike/laugh/emphasize/question), fall back to `love`
 * so agents that react with a wider emoji vocabulary (e.g. 👀 to
 * ack "seen, working on it") still produce a visible tapback instead
 * of failing the whole reaction request.
 *
 * Contract errors (empty input) continue to bubble up so callers
 * still catch misuse.
 *
 * Use this for model-facing paths. Callers that need to detect
 * unsupported input should use {@link normalizeBlueBubblesReactionInputStrict}.
 */
export function normalizeBlueBubblesReactionInput(emoji: string, remove?: boolean): string {
  try {
    return normalizeBlueBubblesReactionInputStrict(emoji, remove);
  } catch (error) {
    if (error instanceof Error && error.name === UNSUPPORTED_REACTION_ERROR) {
      return remove ? "-love" : "love";
    }
    throw error;
  }
}

export async function sendBlueBubblesReaction(params: {
  chatGuid: string;
  messageGuid: string;
  emoji: string;
  remove?: boolean;
  partIndex?: number;
  opts?: BlueBubblesReactionOpts;
}): Promise<void> {
  const chatGuid = params.chatGuid.trim();
  const messageGuid = params.messageGuid.trim();
  if (!chatGuid) {
    throw new Error("BlueBubbles reaction requires chatGuid.");
  }
  if (!messageGuid) {
    throw new Error("BlueBubbles reaction requires messageGuid.");
  }
  const reaction = normalizeBlueBubblesReactionInput(params.emoji, params.remove);
  const client = createBlueBubblesClient(params.opts ?? {});
  if (getCachedBlueBubblesPrivateApiStatus(client.accountId) === false) {
    throw new Error(
      "BlueBubbles reaction requires Private API, but it is disabled on the BlueBubbles server.",
    );
  }
  // Go through the client's typed `react` method — it uses the same SSRF policy
  // as every other client call, eliminating the asymmetric `{}` vs
  // `{ allowedHostnames }` path that caused #59722.
  const res = await client.react({
    chatGuid,
    selectedMessageGuid: messageGuid,
    reaction,
    partIndex: typeof params.partIndex === "number" ? params.partIndex : 0,
    timeoutMs: params.opts?.timeoutMs,
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`BlueBubbles reaction failed (${res.status}): ${errorText || "unknown"}`);
  }
}
