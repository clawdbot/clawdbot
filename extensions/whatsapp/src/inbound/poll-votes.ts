// Whatsapp plugin module decodes WhatsApp poll votes for the poll_vote_received hook.
import { createHash } from "node:crypto";
import type { proto } from "baileys";
import { decryptPollVote, getKeyAuthor, jidNormalizedUser } from "baileys";
import type Long from "long";
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

function toTimestampMs(value: number | Long | null | undefined): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (value && typeof (value as { toNumber?: () => number }).toNumber === "function") {
    return (value as { toNumber: () => number }).toNumber();
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
