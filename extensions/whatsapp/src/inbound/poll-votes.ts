// Whatsapp plugin module decodes WhatsApp poll votes for the poll_vote_received hook.
import { createHash } from "node:crypto";
import type { proto } from "baileys";
import { decryptPollVote, getKeyAuthor, jidNormalizedUser } from "baileys";
import { fireAndForgetBoundedHook } from "openclaw/plugin-sdk/hook-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  rememberWhatsAppBaileysCacheEntry,
  readWhatsAppBaileysCacheEntry,
} from "./baileys-cache.js";
import { findMessageSection } from "./extract.js";

export type WhatsAppDecodedPollVote = {
  /** Id of the poll creation message this vote applies to. */
  pollMessageId: string;
  /** Chat jid the poll lives in. */
  chatJid: string;
  /** Jid of the voter. */
  voter: string;
  /** Decoded option text the voter selected. Empty array means the voter retracted their vote. */
  selectedOptions: string[];
  timestamp?: number;
};

const POLL_CREATION_SECTIONS = [
  "pollCreationMessage",
  "pollCreationMessageV2",
  "pollCreationMessageV3",
  "pollCreationMessageV5",
] as const satisfies readonly (keyof proto.IMessage)[];

function hashPollOptionName(optionName: string): string {
  return createHash("sha256").update(Buffer.from(optionName, "utf8")).digest("hex");
}

/**
 * Maps each poll option's sha256 hash back to its display text so a decoded
 * vote's `selectedOptions` (raw hash bytes) can be resolved to readable text.
 * Reuses `findMessageSection`'s existing FutureProofMessage-chain walk, so
 * `pollCreationMessageV4` (a wrapper around one of the sections above) is
 * covered without special-casing it here.
 */
function buildPollOptionHashMap(pollCreationMessage: proto.IMessage): Map<string, string> {
  const section = findMessageSection(pollCreationMessage, POLL_CREATION_SECTIONS);
  const options = (
    section?.value as { options?: Array<{ optionName?: string | null }> } | undefined
  )?.options;
  const map = new Map<string, string>();
  for (const option of options ?? []) {
    const name = option.optionName?.trim();
    if (name) {
      map.set(hashPollOptionName(name), name);
    }
  }
  return map;
}

/**
 * `senderTimestampMs` is typed by baileys as `number | Long | null` (Long from
 * the `long` package, protobuf's 64-bit int representation). Matched
 * structurally here instead of importing the `Long` type, since `long` is
 * only ever reachable transitively through baileys — not worth a direct
 * dependency declaration for a single type annotation.
 */
type LongLike = { toNumber(): number };

function toTimestampMs(value: number | LongLike | null | undefined): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (value && typeof value.toNumber === "function") {
    return value.toNumber();
  }
  return undefined;
}

/**
 * Decodes an incoming `pollUpdateMessage` (still encrypted as delivered on
 * `messages.upsert`) into a plain vote payload. Baileys 7.0.0-rc13 itself
 * never performs this decode+emit (the relevant branch in its own
 * `process-message.js` is dead/commented-out code), so this replicates it
 * in-plugin using baileys' exported primitives against the single
 * already-managed socket — no parallel connection, no runtime patching.
 *
 * Returns undefined when the message isn't a poll vote, or when the
 * referenced poll creation message isn't in the local cache (e.g. it expired,
 * or arrived before this process started tracking messages).
 */
export function decodeWhatsAppPollVote(params: {
  /** The upserted message envelope carrying the (still encrypted) vote. */
  message: proto.IMessage | null | undefined;
  /** Key of the incoming vote-update message itself. */
  key: proto.IMessageKey;
  /** Reads a previously cached message by remoteJid+id (the poll creation message). */
  getCachedMessage: (remoteJid: string, messageId: string) => proto.IMessage | undefined;
  /** Our own jid, to disambiguate `fromMe` key authorship. */
  selfJid?: string | null;
}): WhatsAppDecodedPollVote | undefined {
  const pollUpdateMessage = params.message?.pollUpdateMessage;
  const creationKey = pollUpdateMessage?.pollCreationMessageKey;
  const vote = pollUpdateMessage?.vote;
  const remoteJid = params.key.remoteJid ?? creationKey?.remoteJid;
  if (!pollUpdateMessage || !creationKey?.id || !vote?.encPayload || !vote?.encIv || !remoteJid) {
    return undefined;
  }
  const pollCreationMessage = params.getCachedMessage(remoteJid, creationKey.id);
  const pollEncKey = pollCreationMessage?.messageContextInfo?.messageSecret;
  if (!pollCreationMessage || !pollEncKey) {
    return undefined;
  }
  const meIdNormalized = params.selfJid ? jidNormalizedUser(params.selfJid) : undefined;
  const pollCreatorJid = getKeyAuthor(creationKey, meIdNormalized);
  const voterJid = getKeyAuthor(params.key, meIdNormalized);
  let decodedVote: proto.Message.PollVoteMessage;
  try {
    decodedVote = decryptPollVote(vote, {
      pollCreatorJid,
      pollMsgId: creationKey.id,
      pollEncKey,
      voterJid,
    });
  } catch {
    return undefined;
  }
  const hashMap = buildPollOptionHashMap(pollCreationMessage);
  const selectedOptions = (decodedVote.selectedOptions ?? [])
    .map((hash) => hashMap.get(Buffer.from(hash).toString("hex")))
    .filter((name): name is string => Boolean(name));
  return {
    pollMessageId: creationKey.id,
    chatJid: remoteJid,
    voter: voterJid,
    selectedOptions,
    timestamp: toTimestampMs(pollUpdateMessage.senderTimestampMs),
  };
}

export function isWhatsAppPollCreationMessage(message: proto.IMessage | null | undefined): boolean {
  if (!message) {
    return false;
  }
  return Boolean(findMessageSection(message, POLL_CREATION_SECTIONS));
}

// Poll retention (both of the caches below) is intentionally in-memory only,
// bounded, and does not survive a process restart. Persisting poll state
// durably is an open design question (tracked in the issue this hook shipped
// with) that needs a maintainer-set retention/privacy contract before this
// module invents one unilaterally.
const OWN_POLL_CREATION_TTL_MS = 10 * 60 * 1000;
const recentOwnPollCreationKeys: Map<string, { expiresAt: number; value: true }> = new Map();

/** Record that a poll creation message at `remoteJid:messageId` was sent by this account (`key.fromMe`). */
export function rememberWhatsAppOwnPollCreation(
  remoteJid: string | null | undefined,
  messageId: string | null | undefined,
): void {
  if (!remoteJid || !messageId) {
    return;
  }
  rememberWhatsAppBaileysCacheEntry(
    recentOwnPollCreationKeys,
    `${remoteJid}:${messageId}`,
    true,
    OWN_POLL_CREATION_TTL_MS,
  );
}

function isOwnPollCreation(remoteJid: string, messageId: string): boolean {
  return (
    readWhatsAppBaileysCacheEntry(recentOwnPollCreationKeys, `${remoteJid}:${messageId}`) === true
  );
}

const POLL_VOTE_DEDUP_TTL_MS = 10 * 60 * 1000;
const recentlyDispatchedPollVoteKeys: Map<string, { expiresAt: number; value: true }> = new Map();

/**
 * Mirrors the `pluginHooks.messageReceived` opt-in gate in
 * `auto-reply/monitor/process-message.ts` — default off, account-level
 * overrides channel-level. Kept local rather than shared since it's the only
 * other privacy-gated inbound hook today.
 */
function shouldEmitWhatsAppPollVoteHooks(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): boolean {
  const channelConfig = params.cfg.channels?.whatsapp;
  const accountConfig = params.accountId ? channelConfig?.accounts?.[params.accountId] : undefined;
  return (
    accountConfig?.pluginHooks?.pollVoteReceived ??
    channelConfig?.pluginHooks?.pollVoteReceived ??
    false
  );
}

const WHATSAPP_POLL_VOTE_RECEIVED_HOOK_LIMITS = {
  maxConcurrency: 8,
  maxQueue: 128,
  timeoutMs: 2_000,
};

/**
 * Fires the poll_vote_received plugin hook. Passive observation only (per
 * #78963) — never triggers an agent run.
 */
function emitWhatsAppPollVoteReceivedHook(params: {
  accountId: string;
  vote: WhatsAppDecodedPollVote;
}): void {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("poll_vote_received")) {
    return;
  }
  fireAndForgetBoundedHook(
    () =>
      hookRunner.runPollVoteReceived(
        {
          pollMessageId: params.vote.pollMessageId,
          chatJid: params.vote.chatJid,
          voter: params.vote.voter,
          selectedOptions: params.vote.selectedOptions,
          timestamp: params.vote.timestamp,
        },
        {
          channelId: "whatsapp",
          accountId: params.accountId,
          conversationId: params.vote.chatJid,
          senderId: params.vote.voter,
          messageId: params.vote.pollMessageId,
        },
      ),
    "whatsapp: poll_vote_received plugin hook failed",
    undefined,
    WHATSAPP_POLL_VOTE_RECEIVED_HOOK_LIMITS,
  );
}

/**
 * Entry point for the `messages.upsert` handler: gate-checks, restricts to
 * polls this account created (the hook's documented privacy boundary — see
 * the security finding this fixes), dedupes a redelivered vote-update
 * upsert, decodes, and dispatches. Synchronous/fire-and-forget by design —
 * callers must never await this before continuing the inbound loop.
 */
export function maybeEmitWhatsAppPollVoteReceivedHook(params: {
  cfg: OpenClawConfig;
  accountId: string;
  message: proto.IMessage | null | undefined;
  key: proto.IMessageKey;
  getCachedMessage: (remoteJid: string, messageId: string) => proto.IMessage | undefined;
  selfJid?: string | null;
}): void {
  if (!shouldEmitWhatsAppPollVoteHooks({ cfg: params.cfg, accountId: params.accountId })) {
    return;
  }
  const creationKey = params.message?.pollUpdateMessage?.pollCreationMessageKey;
  const remoteJid = params.key.remoteJid ?? creationKey?.remoteJid;
  if (!creationKey?.id || !remoteJid || !isOwnPollCreation(remoteJid, creationKey.id)) {
    // Not a poll this account created — stays within the documented
    // "polls OpenClaw created" boundary rather than exposing third-party
    // participants' vote selections to opted-in plugins.
    return;
  }
  const voteUpdateId = params.key.id;
  if (voteUpdateId) {
    const dedupKey = `${remoteJid}:${voteUpdateId}`;
    if (readWhatsAppBaileysCacheEntry(recentlyDispatchedPollVoteKeys, dedupKey)) {
      return;
    }
    rememberWhatsAppBaileysCacheEntry(
      recentlyDispatchedPollVoteKeys,
      dedupKey,
      true,
      POLL_VOTE_DEDUP_TTL_MS,
    );
  }
  const decoded = decodeWhatsAppPollVote({
    message: params.message,
    key: params.key,
    getCachedMessage: params.getCachedMessage,
    selfJid: params.selfJid,
  });
  if (decoded) {
    emitWhatsAppPollVoteReceivedHook({ accountId: params.accountId, vote: decoded });
  }
}
