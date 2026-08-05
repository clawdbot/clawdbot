import type { proto, WAMessageKey } from "baileys";
import { describe, expect, it } from "vitest";
import { decodeWhatsAppPollVote } from "./poll-votes.js";
import {
  buildPollCreationMessageForTests,
  buildPollUpdateMessageForTests,
  encryptPollVoteForTests,
  wrapAsPollCreationMessageV4ForTests,
} from "./poll-votes.test-support.js";

const CHAT_JID = "123456@g.us";
const POLL_CREATOR_JID = "15550001111@s.whatsapp.net";
const VOTER_JID = "15550002222@s.whatsapp.net";
const POLL_MSG_ID = "POLL-CREATION-1";

function creationKeyFor(pollMsgId: string): WAMessageKey {
  return { remoteJid: CHAT_JID, id: pollMsgId, fromMe: true, participant: POLL_CREATOR_JID };
}

function voteKeyFor(id: string): proto.IMessageKey {
  return { remoteJid: CHAT_JID, id, fromMe: false, participant: VOTER_JID };
}

describe("decodeWhatsAppPollVote", () => {
  const pollSections = [
    "pollCreationMessage",
    "pollCreationMessageV2",
    "pollCreationMessageV3",
    "pollCreationMessageV5",
  ] as const;

  it.each(pollSections)("decodes a vote for %s poll creation messages", (section) => {
    const { message: pollCreationMessage, pollEncKey } = buildPollCreationMessageForTests({
      section,
      options: ["Pizza", "Sushi", "Tacos"],
    });
    const creationKey = creationKeyFor(POLL_MSG_ID);
    const vote = encryptPollVoteForTests({
      selectedOptionNames: ["Sushi"],
      pollEncKey,
      pollCreatorJid: POLL_CREATOR_JID,
      pollMsgId: POLL_MSG_ID,
      voterJid: VOTER_JID,
    });
    const voteMessage = buildPollUpdateMessageForTests({
      creationKey,
      vote,
      senderTimestampMs: 1_700_000_000_000,
    });

    const decoded = decodeWhatsAppPollVote({
      message: voteMessage,
      key: voteKeyFor("VOTE-1"),
      getCachedMessage: (remoteJid, messageId) =>
        remoteJid === CHAT_JID && messageId === POLL_MSG_ID ? pollCreationMessage : undefined,
      selfJid: POLL_CREATOR_JID,
    });

    expect(decoded).toEqual({
      pollMessageId: POLL_MSG_ID,
      chatJid: CHAT_JID,
      voter: VOTER_JID,
      selectedOptions: ["Sushi"],
      timestamp: 1_700_000_000_000,
    });
  });

  it("decodes a vote for pollCreationMessageV4 (FutureProofMessage wrapper)", () => {
    const { message: innerPollCreationMessage, pollEncKey } = buildPollCreationMessageForTests({
      section: "pollCreationMessage",
      options: ["Yes", "No"],
    });
    const wrappedPollCreationMessage =
      wrapAsPollCreationMessageV4ForTests(innerPollCreationMessage);
    const creationKey = creationKeyFor(POLL_MSG_ID);
    const vote = encryptPollVoteForTests({
      selectedOptionNames: ["Yes"],
      pollEncKey,
      pollCreatorJid: POLL_CREATOR_JID,
      pollMsgId: POLL_MSG_ID,
      voterJid: VOTER_JID,
    });
    const voteMessage = buildPollUpdateMessageForTests({ creationKey, vote });

    const decoded = decodeWhatsAppPollVote({
      message: voteMessage,
      key: voteKeyFor("VOTE-2"),
      getCachedMessage: () => wrappedPollCreationMessage,
      selfJid: POLL_CREATOR_JID,
    });

    expect(decoded?.selectedOptions).toEqual(["Yes"]);
  });

  it("decodes multiple selected options", () => {
    const { message: pollCreationMessage, pollEncKey } = buildPollCreationMessageForTests({
      section: "pollCreationMessage",
      options: ["Mon", "Tue", "Wed"],
    });
    const creationKey = creationKeyFor(POLL_MSG_ID);
    const vote = encryptPollVoteForTests({
      selectedOptionNames: ["Mon", "Wed"],
      pollEncKey,
      pollCreatorJid: POLL_CREATOR_JID,
      pollMsgId: POLL_MSG_ID,
      voterJid: VOTER_JID,
    });
    const voteMessage = buildPollUpdateMessageForTests({ creationKey, vote });

    const decoded = decodeWhatsAppPollVote({
      message: voteMessage,
      key: voteKeyFor("VOTE-3"),
      getCachedMessage: () => pollCreationMessage,
      selfJid: POLL_CREATOR_JID,
    });

    expect(decoded?.selectedOptions.toSorted()).toEqual(["Mon", "Wed"]);
  });

  it("decodes a retracted vote (empty selectedOptions) rather than dropping it", () => {
    const { message: pollCreationMessage, pollEncKey } = buildPollCreationMessageForTests({
      section: "pollCreationMessage",
      options: ["A", "B"],
    });
    const creationKey = creationKeyFor(POLL_MSG_ID);
    const vote = encryptPollVoteForTests({
      selectedOptionNames: [],
      pollEncKey,
      pollCreatorJid: POLL_CREATOR_JID,
      pollMsgId: POLL_MSG_ID,
      voterJid: VOTER_JID,
    });
    const voteMessage = buildPollUpdateMessageForTests({ creationKey, vote });

    const decoded = decodeWhatsAppPollVote({
      message: voteMessage,
      key: voteKeyFor("VOTE-4"),
      getCachedMessage: () => pollCreationMessage,
      selfJid: POLL_CREATOR_JID,
    });

    expect(decoded?.selectedOptions).toEqual([]);
  });

  it("returns undefined when the poll creation message isn't cached (e.g. expired)", () => {
    const { pollEncKey } = buildPollCreationMessageForTests({
      section: "pollCreationMessage",
      options: ["A", "B"],
    });
    const creationKey = creationKeyFor(POLL_MSG_ID);
    const vote = encryptPollVoteForTests({
      selectedOptionNames: ["A"],
      pollEncKey,
      pollCreatorJid: POLL_CREATOR_JID,
      pollMsgId: POLL_MSG_ID,
      voterJid: VOTER_JID,
    });
    const voteMessage = buildPollUpdateMessageForTests({ creationKey, vote });

    const decoded = decodeWhatsAppPollVote({
      message: voteMessage,
      key: voteKeyFor("VOTE-5"),
      getCachedMessage: () => undefined,
      selfJid: POLL_CREATOR_JID,
    });

    expect(decoded).toBeUndefined();
  });

  it("returns undefined for a non-poll message", () => {
    const decoded = decodeWhatsAppPollVote({
      message: { conversation: "hi" },
      key: voteKeyFor("VOTE-6"),
      getCachedMessage: () => undefined,
      selfJid: POLL_CREATOR_JID,
    });

    expect(decoded).toBeUndefined();
  });

  it("decodes a vote when messageSecret arrives as a base64 string instead of raw bytes", () => {
    // Mirrors the messages.upsert echo of a poll we just sent ourselves,
    // before it round-trips through the wire as proper Uint8Array bytes.
    const { message: pollCreationMessage, pollEncKey } = buildPollCreationMessageForTests({
      section: "pollCreationMessage",
      options: ["A", "B"],
      messageSecretAsBase64String: true,
    });
    const creationKey = creationKeyFor(POLL_MSG_ID);
    const vote = encryptPollVoteForTests({
      selectedOptionNames: ["A"],
      pollEncKey,
      pollCreatorJid: POLL_CREATOR_JID,
      pollMsgId: POLL_MSG_ID,
      voterJid: VOTER_JID,
    });
    const voteMessage = buildPollUpdateMessageForTests({ creationKey, vote });

    const decoded = decodeWhatsAppPollVote({
      message: voteMessage,
      key: voteKeyFor("VOTE-BASE64-SECRET"),
      getCachedMessage: () => pollCreationMessage,
      selfJid: POLL_CREATOR_JID,
    });

    expect(decoded?.selectedOptions).toEqual(["A"]);
  });

  it("decodes a vote in a LID-addressed DM using selfLid, not the PN-preferring getKeyAuthor default", () => {
    // A LID-migrated DM: the conversation's own remoteJid is the @lid form,
    // and Baileys attaches the PN cross-reference on remoteJidAlt. Using the
    // Alt (PN) form for the crypto call — what getKeyAuthor prefers for
    // authorship display — fails GCM auth; only the primary @lid form
    // (matching what WhatsApp actually signed) decrypts successfully.
    const DM_LID_JID = "999999111@lid";
    const SELF_JID = "15550001111@s.whatsapp.net";
    const SELF_LID = "15550009999@lid";
    const VOTER_PN_ALT = "15550002222@s.whatsapp.net";

    const { message: pollCreationMessage, pollEncKey } = buildPollCreationMessageForTests({
      section: "pollCreationMessage",
      options: ["Yes", "No"],
    });
    const creationKey: WAMessageKey = {
      remoteJid: DM_LID_JID,
      id: POLL_MSG_ID,
      fromMe: true,
    };
    const vote = encryptPollVoteForTests({
      selectedOptionNames: ["Yes"],
      pollEncKey,
      pollCreatorJid: SELF_LID,
      pollMsgId: POLL_MSG_ID,
      voterJid: DM_LID_JID,
    });
    const voteMessage = buildPollUpdateMessageForTests({ creationKey, vote });

    const decoded = decodeWhatsAppPollVote({
      message: voteMessage,
      key: {
        remoteJid: DM_LID_JID,
        remoteJidAlt: VOTER_PN_ALT,
        id: "VOTE-LID-DM",
        fromMe: false,
      } as proto.IMessageKey,
      getCachedMessage: (remoteJid, messageId) =>
        remoteJid === DM_LID_JID && messageId === POLL_MSG_ID ? pollCreationMessage : undefined,
      selfJid: SELF_JID,
      selfLid: SELF_LID,
    });

    expect(decoded?.selectedOptions).toEqual(["Yes"]);
    expect(decoded?.chatJid).toBe(DM_LID_JID);
  });

  it("returns undefined when decryption fails (wrong key / tampered payload)", () => {
    const { message: pollCreationMessage } = buildPollCreationMessageForTests({
      section: "pollCreationMessage",
      options: ["A", "B"],
    });
    const creationKey = creationKeyFor(POLL_MSG_ID);
    const vote = encryptPollVoteForTests({
      selectedOptionNames: ["A"],
      pollEncKey: new Uint8Array(32), // wrong key relative to the cached poll's real secret
      pollCreatorJid: POLL_CREATOR_JID,
      pollMsgId: POLL_MSG_ID,
      voterJid: VOTER_JID,
    });
    const voteMessage = buildPollUpdateMessageForTests({ creationKey, vote });

    const decoded = decodeWhatsAppPollVote({
      message: voteMessage,
      key: voteKeyFor("VOTE-7"),
      getCachedMessage: () => pollCreationMessage,
      selfJid: POLL_CREATOR_JID,
    });

    expect(decoded).toBeUndefined();
  });
});
