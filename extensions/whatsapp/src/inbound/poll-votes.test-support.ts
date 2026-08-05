// Whatsapp plugin module builds encrypted poll-vote fixtures for tests.
// Mirrors the exact AES-256-GCM/HKDF-style scheme baileys' own (unexported)
// decryptPollVote uses, so tests can produce ciphertext decodeWhatsAppPollVote
// can genuinely decrypt, without depending on baileys' internal (un-typed)
// crypto exports.
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { proto, type WAMessageKey } from "baileys";

function hashPollOptionNameForTests(optionName: string): Buffer {
  return createHash("sha256").update(Buffer.from(optionName, "utf8")).digest();
}

function derivePollVoteKey(pollEncKey: Uint8Array, sign: Buffer): Buffer {
  const key0 = createHmac("sha256", Buffer.alloc(32)).update(Buffer.from(pollEncKey)).digest();
  return createHmac("sha256", key0).update(sign).digest();
}

export function encryptPollVoteForTests(params: {
  selectedOptionNames: string[];
  pollEncKey: Uint8Array;
  pollCreatorJid: string;
  pollMsgId: string;
  voterJid: string;
}): proto.Message.IPollEncValue {
  const { pollEncKey, pollCreatorJid, pollMsgId, voterJid, selectedOptionNames } = params;
  const sign = Buffer.concat([
    Buffer.from(pollMsgId),
    Buffer.from(pollCreatorJid),
    Buffer.from(voterJid),
    Buffer.from("Poll Vote"),
    Uint8Array.from([1]),
  ]);
  const decKey = derivePollVoteKey(pollEncKey, sign);
  const aad = Buffer.from(`${pollMsgId}\0${voterJid}`);
  const encIv = randomBytes(12);
  const plaintext = proto.Message.PollVoteMessage.encode({
    selectedOptions: selectedOptionNames.map((name) => hashPollOptionNameForTests(name)),
  }).finish();
  const cipher = createCipheriv("aes-256-gcm", decKey, encIv);
  cipher.setAAD(aad);
  const encPayload = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { encPayload, encIv };
}

/** Builds a poll creation message content in the given section, with a random encryption key. */
export function buildPollCreationMessageForTests(params: {
  section:
    | "pollCreationMessage"
    | "pollCreationMessageV2"
    | "pollCreationMessageV3"
    | "pollCreationMessageV5";
  question?: string;
  options: string[];
  pollEncKey?: Uint8Array;
  /**
   * Store `messageContextInfo.messageSecret` as a base64 string instead of
   * raw bytes, mirroring the shape observed on the `messages.upsert` echo of
   * a poll we just sent ourselves (not yet round-tripped through the wire).
   */
  messageSecretAsBase64String?: boolean;
}): { message: proto.IMessage; pollEncKey: Uint8Array } {
  const pollEncKey = params.pollEncKey ?? randomBytes(32);
  const pollCreation: proto.Message.IPollCreationMessage = {
    name: params.question ?? "Test poll?",
    options: params.options.map((optionName) => ({ optionName })),
  };
  const messageSecret = params.messageSecretAsBase64String
    ? (Buffer.from(pollEncKey).toString("base64") as unknown as Uint8Array)
    : pollEncKey;
  return {
    message: {
      [params.section]: pollCreation,
      messageContextInfo: { messageSecret },
    },
    pollEncKey,
  };
}

/** Wraps a poll creation message content in a V4 FutureProofMessage envelope. */
export function wrapAsPollCreationMessageV4ForTests(inner: proto.IMessage): proto.IMessage {
  return {
    pollCreationMessageV4: { message: inner },
    messageContextInfo: inner.messageContextInfo,
  };
}

export function buildPollUpdateMessageForTests(params: {
  creationKey: WAMessageKey;
  vote: proto.Message.IPollEncValue;
  senderTimestampMs?: number;
}): proto.IMessage {
  return {
    pollUpdateMessage: {
      pollCreationMessageKey: params.creationKey,
      vote: params.vote,
      senderTimestampMs: params.senderTimestampMs ?? Date.now(),
    },
  };
}
