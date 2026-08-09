// Telegram plugin module implements public-poll vote routing registry behavior.
//
// Telegram only emits `poll_answer` updates for non-anonymous (public) polls, and those
// updates do not carry the originating chat/thread. Persist the authoritative route
// returned by sendPoll so a later vote can enter the normal inbound turn pipeline.
import type { Chat } from "grammy/types";
import { parseStrictInteger } from "openclaw/plugin-sdk/number-runtime";
import type {
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getTelegramRuntime } from "./runtime.js";

const TELEGRAM_POLL_REGISTRY_NAMESPACE = "telegram.poll-registry";
const TELEGRAM_POLL_REGISTRY_MAX_ENTRIES = 10_000;
const TELEGRAM_CLOSED_POLL_RETENTION_MS = 48 * 60 * 60 * 1_000;

type TelegramPollRouteChat = Exclude<Chat, { type: "channel" }>;

export type TelegramPollRegistryEntry = {
  pollId: string;
  chat: TelegramPollRouteChat;
  messageId: number;
  messageThreadId?: number;
  question: string;
  options: string[];
};

type TelegramPollRegistryStore = PluginStateKeyedStore<TelegramPollRegistryEntry>;

function openPollRegistryStore(env?: NodeJS.ProcessEnv): TelegramPollRegistryStore {
  return getTelegramRuntime().state.openKeyedStore<TelegramPollRegistryEntry>({
    namespace: TELEGRAM_POLL_REGISTRY_NAMESPACE,
    maxEntries: TELEGRAM_POLL_REGISTRY_MAX_ENTRIES,
    overflowPolicy: "reject-new",
    ...(env ? { env } : {}),
  });
}

function openPollRegistrySyncStore(
  env?: NodeJS.ProcessEnv,
): PluginStateSyncKeyedStore<TelegramPollRegistryEntry> {
  return getTelegramRuntime().state.openSyncKeyedStore<TelegramPollRegistryEntry>({
    namespace: TELEGRAM_POLL_REGISTRY_NAMESPACE,
    maxEntries: TELEGRAM_POLL_REGISTRY_MAX_ENTRIES,
    overflowPolicy: "reject-new",
    ...(env ? { env } : {}),
  });
}

// Public poll ids are globally unique, but keying by account keeps registries isolated
// per bot account and mirrors the other Telegram keyed stores.
export function telegramPollRegistryKey(accountId: string | undefined, pollId: string): string {
  return `${normalizeAccountId(accountId)}:${pollId}`;
}

function normalizePollChat(raw: unknown): TelegramPollRouteChat | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = parseStrictInteger(raw.id);
  if (id === undefined) {
    return null;
  }
  if (raw.type === "private" && typeof raw.first_name === "string") {
    return { id, type: "private", first_name: raw.first_name };
  }
  if (raw.type === "group" && typeof raw.title === "string") {
    return { id, type: "group", title: raw.title };
  }
  if (raw.type === "supergroup" && typeof raw.title === "string") {
    return {
      id,
      type: "supergroup",
      title: raw.title,
      ...(raw.is_forum === true ? { is_forum: true } : {}),
    };
  }
  return null;
}

function normalizePollRegistryEntry(raw: unknown): TelegramPollRegistryEntry | null {
  if (!isRecord(raw)) {
    return null;
  }
  const chat = normalizePollChat(raw.chat);
  const messageId = parseStrictInteger(raw.messageId);
  const messageThreadId = parseStrictInteger(raw.messageThreadId);
  if (
    typeof raw.pollId !== "string" ||
    !chat ||
    messageId === undefined ||
    typeof raw.question !== "string" ||
    !Array.isArray(raw.options) ||
    !raw.options.every((option) => typeof option === "string") ||
    (raw.messageThreadId != null && messageThreadId === undefined)
  ) {
    return null;
  }
  return {
    pollId: raw.pollId,
    chat,
    messageId,
    ...(messageThreadId === undefined ? {} : { messageThreadId }),
    question: raw.question,
    options: raw.options,
  };
}

export async function recordTelegramPollRegistryEntry(params: {
  accountId?: string;
  pollId: string;
  chat: TelegramPollRouteChat;
  messageId: number;
  messageThreadId?: number;
  question: string;
  options: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<TelegramPollRegistryEntry> {
  const entry = createTelegramPollRegistryEntry(params);
  await openPollRegistryStore(params.env).register(
    telegramPollRegistryKey(params.accountId, params.pollId),
    entry,
  );
  return entry;
}

export function createTelegramPollRegistryEntry(params: {
  pollId: string;
  chat: TelegramPollRouteChat;
  messageId: number;
  messageThreadId?: number;
  question: string;
  options: string[];
}): TelegramPollRegistryEntry {
  // The keyed store persists JSON and rejects explicit `undefined`, so only include the
  // optional thread id when it is actually present.
  return {
    pollId: params.pollId,
    chat: params.chat,
    messageId: params.messageId,
    question: params.question,
    options: [...params.options],
    ...(typeof params.messageThreadId === "number"
      ? { messageThreadId: Math.floor(params.messageThreadId) }
      : {}),
  };
}

export async function findTelegramPollRegistryEntry(params: {
  accountId?: string;
  pollId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<TelegramPollRegistryEntry | null> {
  // Missing entries resolve to `undefined`; real store failures must propagate so
  // durable Telegram ingress can release the claim and retry the poll_answer.
  const stored = await openPollRegistryStore(params.env).lookup(
    telegramPollRegistryKey(params.accountId, params.pollId),
  );
  return normalizePollRegistryEntry(stored);
}

export function findTelegramPollRegistryEntrySync(params: {
  accountId?: string;
  pollId: string;
  env?: NodeJS.ProcessEnv;
}): TelegramPollRegistryEntry | null {
  const stored = openPollRegistrySyncStore(params.env).lookup(
    telegramPollRegistryKey(params.accountId, params.pollId),
  );
  return normalizePollRegistryEntry(stored);
}

export async function retireTelegramPollRegistryEntry(params: {
  accountId?: string;
  pollId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const store = openPollRegistryStore(params.env);
  const key = telegramPollRegistryKey(params.accountId, params.pollId);
  const entry = normalizePollRegistryEntry(await store.lookup(key));
  if (!entry) {
    return;
  }
  // Keep the route beyond Telegram's 24-hour update window so a durable replay
  // that started before the close update can still deliver its vote.
  await store.register(key, entry, { ttlMs: TELEGRAM_CLOSED_POLL_RETENTION_MS });
}
