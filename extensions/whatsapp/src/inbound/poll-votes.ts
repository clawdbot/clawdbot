// Whatsapp plugin module decodes WhatsApp poll votes for the poll_vote_received hook.
import { createHash } from "node:crypto";
import type { proto } from "baileys";
import { decryptPollVote, getKeyAuthor, jidNormalizedUser } from "baileys";
import { resolveAccountEntry } from "openclaw/plugin-sdk/account-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { fireAndForgetBoundedHook } from "openclaw/plugin-sdk/hook-runtime";
import { getChildLogger } from "openclaw/plugin-sdk/logging-core";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
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

const POLL_UPDATE_SECTIONS = [
  "pollUpdateMessage",
] as const satisfies readonly (keyof proto.IMessage)[];

/**
 * Reads a message's `pollUpdateMessage` section, unwrapping ephemeral/
 * view-once/other FutureProofMessage envelopes the same way poll creation
 * detection already does via `findMessageSection` — a vote update WhatsApp
 * delivers wrapped (e.g. inside an ephemeral message) would otherwise bypass
 * a bare top-level `message.pollUpdateMessage` check and be silently dropped.
 */
export function extractWhatsAppPollUpdateMessage(
  message: proto.IMessage | null | undefined,
): proto.Message.IPollUpdateMessage | undefined {
  if (!message) {
    return undefined;
  }
  // SAFETY: POLL_UPDATE_SECTIONS restricts findMessageSection to the poll-update protobuf variant.
  return findMessageSection(message, POLL_UPDATE_SECTIONS)?.value as
    | proto.Message.IPollUpdateMessage
    | undefined;
}

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
  const options =
    // SAFETY: POLL_CREATION_SECTIONS contains only poll creation protobuf variants, all with options.
    (section?.value as { options?: Array<{ optionName?: string | null }> } | undefined)?.options;
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
 * `decryptPollVote`'s AAD/key-derivation must be given the same address
 * space (LID or PN) the two participants actually used when WhatsApp
 * encrypted the vote client-side — mixing forms (or using the Alt/PN
 * cross-reference `getKeyAuthor` prefers) fails GCM authentication even
 * though the vote is genuinely ours. Baileys attaches the LID/PN alternate
 * on `remoteJidAlt`/`participantAlt`, so `getKeyAuthor`'s default preference
 * for the Alt form is right for authorship display but wrong for this
 * decrypt — the primary `participant`/`remoteJid` field (whichever space
 * the conversation is natively in) is what the encryptor actually signed.
 */
function resolvePollVoterJidForDecrypt(
  key: proto.IMessageKey,
  selfJid: string | null | undefined,
  selfLid: string | null | undefined,
): string | undefined {
  if (key.participant) {
    return key.participant;
  }
  if (key.fromMe) {
    // A self-authored vote (e.g. voting on your own poll in a self-chat DM)
    // has no `participant` — `remoteJid` holds the DM peer's jid, not ours.
    // Resolve to our own identity instead, matching whichever address space
    // (LID or PN) the conversation is natively in, mirroring
    // resolvePollCreatorJidForDecrypt below.
    const referenceJid = key.remoteJid || "";
    return referenceJid.endsWith("@lid")
      ? (selfLid ?? selfJid ?? undefined)
      : (selfJid ?? selfLid ?? undefined);
  }
  return key.remoteJid || undefined;
}

/**
 * Mirrors the voter-side resolution above for the poll's creator.
 *
 * When the poll is someone else's (`fromMe` false with an explicit
 * `participant`), that participant *is* the creator, and it is already in
 * the address space the encryptor signed — use it directly. The
 * `poll_vote_received` hook never reaches this case, because its ownership
 * gate only admits polls this gateway sent; the QA driver does, since it
 * observes any poll in the conversation.
 *
 * Otherwise the poll is ours, and `participant`/`remoteJid` only tells us
 * which space (LID or PN) the conversation is natively in — our own
 * identity in that same space is what was signed.
 */
function resolvePollCreatorJidForDecrypt(
  creationKey: proto.IMessageKey,
  selfJid: string | null | undefined,
  selfLid: string | null | undefined,
): string | undefined {
  if (!creationKey.fromMe && creationKey.participant) {
    return creationKey.participant;
  }
  const referenceJid = creationKey.participant || creationKey.remoteJid || "";
  return referenceJid.endsWith("@lid")
    ? (selfLid ?? selfJid ?? undefined)
    : (selfJid ?? selfLid ?? undefined);
}

/**
 * `messageContextInfo.messageSecret` is typed as `bytes` and normally
 * arrives as a `Uint8Array`, but the echo of a poll we just sent ourselves
 * (still in-memory, not yet round-tripped through the wire) carries it as a
 * base64 string instead. Decode defensively so both shapes work.
 */
function toPollEncKeyBuffer(value: Uint8Array | string | null | undefined): Buffer | undefined {
  if (!value) {
    return undefined;
  }
  return typeof value === "string" ? Buffer.from(value, "base64") : Buffer.from(value);
}

/**
 * Decodes an incoming `pollUpdateMessage` (still encrypted as delivered on
 * `messages.upsert`) into a plain vote payload. The checked-in Baileys
 * 7.0.0-rc14 package exports `decryptPollVote` from `lib/Utils/process-message`
 * and still leaves its automatic poll-vote decode/emit branch disabled, so
 * this replicates that operation in-plugin using the exported primitive
 * against the single already-managed socket — no parallel connection, no
 * runtime patching.
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
  /** Our own LID-space identity, when this account has one (LID-migrated). */
  selfLid?: string | null;
}): WhatsAppDecodedPollVote | undefined {
  const pollUpdateMessage = extractWhatsAppPollUpdateMessage(params.message);
  const creationKey = pollUpdateMessage?.pollCreationMessageKey;
  const vote = pollUpdateMessage?.vote;
  const remoteJid = params.key.remoteJid ?? creationKey?.remoteJid;
  if (!pollUpdateMessage || !creationKey?.id || !vote?.encPayload || !vote?.encIv || !remoteJid) {
    return undefined;
  }
  const pollCreationMessage = params.getCachedMessage(remoteJid, creationKey.id);
  const pollEncKey = toPollEncKeyBuffer(pollCreationMessage?.messageContextInfo?.messageSecret);
  if (!pollCreationMessage || !pollEncKey) {
    return undefined;
  }
  const meIdNormalized = params.selfJid ? jidNormalizedUser(params.selfJid) : undefined;
  // Reported to hook consumers: the human-recognizable PN-preferring form.
  const voterJid = getKeyAuthor(params.key, meIdNormalized);
  // Used only for the crypto call: the conversation's native address space.
  const decryptCreatorJid = resolvePollCreatorJidForDecrypt(
    creationKey,
    params.selfJid,
    params.selfLid,
  );
  const decryptVoterJid = resolvePollVoterJidForDecrypt(params.key, params.selfJid, params.selfLid);
  let decodedVote: proto.Message.PollVoteMessage;
  try {
    if (!decryptCreatorJid || !decryptVoterJid) {
      throw new Error("missing creator/voter jid for poll vote decrypt");
    }
    decodedVote = decryptPollVote(vote, {
      pollCreatorJid: decryptCreatorJid,
      pollMsgId: creationKey.id,
      pollEncKey,
      voterJid: decryptVoterJid,
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

// Poll state is intentionally process-local and bounded. Persisting the
// creation message would retain its decryption secret after a restart.
const OWN_POLL_CREATION_TTL_MS = 10 * 60 * 1000;
const recentOwnPollCreationKeys: Map<string, { expiresAt: number; value: true }> = new Map();

/**
 * Record that a poll creation message at `remoteJid:messageId` was sent by
 * this specific account (`key.fromMe`). Keyed by `accountId` too — with
 * multiple connected WhatsApp accounts possibly observing the same group,
 * an unscoped key would let account A's poll ownership authorize account
 * B's opted-in hook to receive account A's vote data.
 */
export function rememberWhatsAppOwnPollCreation(
  accountId: string,
  remoteJid: string | null | undefined,
  messageId: string | null | undefined,
): void {
  if (!remoteJid || !messageId) {
    return;
  }
  rememberWhatsAppBaileysCacheEntry(
    recentOwnPollCreationKeys,
    `${accountId}:${remoteJid}:${messageId}`,
    true,
    OWN_POLL_CREATION_TTL_MS,
  );
}

function isOwnPollCreation(accountId: string, remoteJid: string, messageId: string): boolean {
  return (
    readWhatsAppBaileysCacheEntry(
      recentOwnPollCreationKeys,
      `${accountId}:${remoteJid}:${messageId}`,
    ) === true
  );
}

const POLL_VOTE_DEDUP_TTL_MS = 10 * 60 * 1000;
const recentlyDispatchedPollVoteKeys: Map<string, { expiresAt: number; value: true }> = new Map();
const POLL_VOTE_DECODE_FAILURE_LOG_TTL_MS = 10 * 60 * 1000;
const recentPollVoteDecodeFailureKeys: Map<string, { expiresAt: number; value: true }> = new Map();
const pollVoteLogger = getChildLogger({ module: "web-poll-votes" });

/**
 * Mirrors the `pluginHooks.messageReceived` opt-in gate in
 * `auto-reply/monitor/process-message.ts` — default off, account-level
 * overrides channel-level. Kept local rather than shared since it's the only
 * other privacy-gated inbound hook today.
 */
export function shouldEmitWhatsAppPollVoteHooks(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): boolean {
  const channelConfig = params.cfg.channels?.whatsapp;
  const accountConfig = params.accountId
    ? resolveAccountEntry(channelConfig?.accounts, params.accountId)
    : undefined;
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
 *
 * Returns whether the vote was handed off to the hook runner: `false` means
 * either no handler is registered or the bounded queue was full and dropped
 * it. Callers must not record dedupe state for a `false` result — the vote
 * was never delivered, so a later redelivery is the only remaining chance
 * to deliver it.
 */
function emitWhatsAppPollVoteReceivedHook(params: {
  accountId: string;
  vote: WhatsAppDecodedPollVote;
  /** The vote-update message's own id — distinct per vote/retraction, unlike pollMessageId (shared by every vote on the same poll). */
  voteUpdateId: string;
}): boolean {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("poll_vote_received")) {
    return false;
  }
  return fireAndForgetBoundedHook(
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
          // The vote-update id, not the poll creation id: every vote and
          // retraction on the same poll must get a distinct hook message
          // identity so consumers can correlate/dedupe individual events.
          messageId: params.voteUpdateId,
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
  selfLid?: string | null;
}): void {
  if (!shouldEmitWhatsAppPollVoteHooks({ cfg: params.cfg, accountId: params.accountId })) {
    return;
  }
  const creationKey = extractWhatsAppPollUpdateMessage(params.message)?.pollCreationMessageKey;
  const remoteJid = params.key.remoteJid ?? creationKey?.remoteJid;
  if (
    !creationKey?.id ||
    !remoteJid ||
    !isOwnPollCreation(params.accountId, remoteJid, creationKey.id)
  ) {
    // Not a poll this account created — stays within the documented
    // "polls OpenClaw created" boundary rather than exposing third-party
    // participants' vote selections to opted-in plugins. Account-scoped so
    // one connected account's poll can't authorize another account's hook.
    return;
  }
  const voteUpdateId = params.key.id;
  if (voteUpdateId) {
    const dedupKey = `${params.accountId}:${remoteJid}:${voteUpdateId}`;
    if (readWhatsAppBaileysCacheEntry(recentlyDispatchedPollVoteKeys, dedupKey)) {
      return;
    }
  }
  const decoded = decodeWhatsAppPollVote({
    message: params.message,
    key: params.key,
    getCachedMessage: params.getCachedMessage,
    selfJid: params.selfJid,
    selfLid: params.selfLid,
  });
  if (!decoded) {
    const failureKey = `${params.accountId}:${remoteJid}:${creationKey.id}`;
    if (!readWhatsAppBaileysCacheEntry(recentPollVoteDecodeFailureKeys, failureKey)) {
      rememberWhatsAppBaileysCacheEntry(
        recentPollVoteDecodeFailureKeys,
        failureKey,
        true,
        POLL_VOTE_DECODE_FAILURE_LOG_TTL_MS,
      );
      // Ownership was established by an accepted local send. Keep third-party
      // polls silent, but make this bounded, redacted non-outcome observable.
      pollVoteLogger.warn(
        "whatsapp poll_vote_received not dispatched: locally created poll could not be decoded",
      );
    }
    // Decode failed (e.g. the poll creation payload hasn't arrived/been
    // cached yet) — leave the vote-update id undeduped so a later
    // redelivery, once the payload is available, can still be decoded and
    // dispatched instead of being silently suppressed as a duplicate.
    return;
  }
  const admitted = emitWhatsAppPollVoteReceivedHook({
    accountId: params.accountId,
    vote: decoded,
    // Falls back to the poll id in the (practically unseen) case a vote
    // update key has no id of its own — still a valid identity, just not
    // distinct per-vote.
    voteUpdateId: voteUpdateId ?? decoded.pollMessageId,
  });
  if (!admitted || !voteUpdateId) {
    // The hook was never handed off (no registered handler, or the bounded
    // queue was full and dropped it). Recording dedupe here would mark the
    // vote as delivered when nothing ran, and the dedupe gate above would
    // then suppress the redelivery that is the only remaining chance to
    // deliver it. Leave it replayable instead.
    return;
  }
  rememberWhatsAppBaileysCacheEntry(
    recentlyDispatchedPollVoteKeys,
    `${params.accountId}:${remoteJid}:${voteUpdateId}`,
    true,
    POLL_VOTE_DEDUP_TTL_MS,
  );
}
