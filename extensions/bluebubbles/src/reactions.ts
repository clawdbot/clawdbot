import { resolveBlueBubblesAccount } from "./accounts.js";
import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import { blueBubblesFetchWithTimeout, buildBlueBubblesApiUrl } from "./types.js";

export type BlueBubblesReactionOpts = {
  serverUrl?: string;
  password?: string;
  accountId?: string;
  timeoutMs?: number;
  cfg?: ClawdbotConfig;
};

const REACTION_TYPES = new Set([
  "love",
  "like",
  "dislike",
  "laugh",
  "emphasize",
  "question",
]);

const REACTION_ALIASES = new Map<string, string>([
  ["heart", "love"],
  ["thumbs_up", "like"],
  ["thumbs-down", "dislike"],
  ["thumbs_down", "dislike"],
  ["haha", "laugh"],
  ["lol", "laugh"],
  ["emphasis", "emphasize"],
  ["exclaim", "emphasize"],
  ["question", "question"],
]);

const REACTION_EMOJIS = new Map<string, string>([
  ["❤️", "love"],
  ["❤", "love"],
  ["♥️", "love"],
  ["😍", "love"],
  ["👍", "like"],
  ["👎", "dislike"],
  ["😂", "laugh"],
  ["🤣", "laugh"],
  ["😆", "laugh"],
  ["‼️", "emphasize"],
  ["‼", "emphasize"],
  ["❗", "emphasize"],
  ["❓", "question"],
  ["❔", "question"],
]);

function resolveAccount(params: BlueBubblesReactionOpts) {
  const account = resolveBlueBubblesAccount({
    cfg: params.cfg ?? {},
    accountId: params.accountId,
  });
  const baseUrl = params.serverUrl?.trim() || account.config.serverUrl?.trim();
  const password = params.password?.trim() || account.config.password?.trim();
  if (!baseUrl) throw new Error("BlueBubbles serverUrl is required");
  if (!password) throw new Error("BlueBubbles password is required");
  return { baseUrl, password };
}

function normalizeReactionInput(emoji: string, remove?: boolean): string {
  const trimmed = emoji.trim();
  if (!trimmed) throw new Error("BlueBubbles reaction requires an emoji or name.");
  let raw = trimmed.toLowerCase();
  if (raw.startsWith("-")) raw = raw.slice(1);
  const aliased = REACTION_ALIASES.get(raw) ?? raw;
  const mapped = REACTION_EMOJIS.get(trimmed) ?? REACTION_EMOJIS.get(raw) ?? aliased;
  if (!REACTION_TYPES.has(mapped)) {
    throw new Error(`Unsupported BlueBubbles reaction: ${trimmed}`);
  }
  return remove ? `-${mapped}` : mapped;
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
  if (!chatGuid) throw new Error("BlueBubbles reaction requires chatGuid.");
  if (!messageGuid) throw new Error("BlueBubbles reaction requires messageGuid.");
  const reaction = normalizeReactionInput(params.emoji, params.remove);
  const { baseUrl, password } = resolveAccount(params.opts ?? {});
  const url = buildBlueBubblesApiUrl({
    baseUrl,
    path: "/api/v1/message/react",
    password,
  });
  const payload = {
    chatGuid,
    selectedMessageGuid: messageGuid,
    reaction,
    partIndex: typeof params.partIndex === "number" ? params.partIndex : 0,
  };
  const res = await blueBubblesFetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    params.opts?.timeoutMs,
  );
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`BlueBubbles reaction failed (${res.status}): ${errorText || "unknown"}`);
  }
}
