import type { proto, WAMessageKey } from "baileys";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeWhatsAppPollVote,
  maybeEmitWhatsAppPollVoteReceivedHook,
  rememberWhatsAppOwnPollCreation,
} from "./poll-votes.js";
import {
  buildPollCreationMessageForTests,
  buildPollUpdateMessageForTests,
  encryptPollVoteForTests,
  wrapAsPollCreationMessageV4ForTests,
} from "./poll-votes.test-support.js";

const { runPollVoteReceivedMock, hasHooksMock, pollVoteWarningMock } = vi.hoisted(() => ({
  runPollVoteReceivedMock: vi.fn(async () => undefined),
  // Defaults to "a poll_vote_received handler is registered"; individual
  // tests can override once via mockReturnValueOnce to exercise the
  // no-handler path.
  hasHooksMock: vi.fn((hookName: string) => hookName === "poll_vote_received"),
  pollVoteWarningMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/logging-core", () => ({
  getChildLogger: () => ({ warn: pollVoteWarningMock }),
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: hasHooksMock,
    runPollVoteReceived: runPollVoteReceivedMock,
  }),
}));

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

  it("decodes a vote update wrapped in an ephemeralMessage envelope", () => {
    // Regression: the vote-update entry point used to read
    // message.pollUpdateMessage directly, bypassing the same
    // wrapper-unwrapping poll creation detection already applies — a vote
    // WhatsApp delivers inside a disappearing-message envelope would
    // silently fail to decode.
    const { message: pollCreationMessage, pollEncKey } = buildPollCreationMessageForTests({
      section: "pollCreationMessage",
      options: ["Pizza", "Sushi"],
    });
    const creationKey = creationKeyFor(POLL_MSG_ID);
    const vote = encryptPollVoteForTests({
      selectedOptionNames: ["Sushi"],
      pollEncKey,
      pollCreatorJid: POLL_CREATOR_JID,
      pollMsgId: POLL_MSG_ID,
      voterJid: VOTER_JID,
    });
    const voteMessage = buildPollUpdateMessageForTests({ creationKey, vote });
    const wrappedVoteMessage = { ephemeralMessage: { message: voteMessage } };

    const decoded = decodeWhatsAppPollVote({
      message: wrappedVoteMessage,
      key: voteKeyFor("VOTE-EPHEMERAL"),
      getCachedMessage: () => pollCreationMessage,
      selfJid: POLL_CREATOR_JID,
    });

    expect(decoded?.selectedOptions).toEqual(["Sushi"]);
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

  it("decodes a self-authored vote in a DM (fromMe vote, no participant, remoteJid is the peer)", () => {
    // Regression: a self-authored DM vote key has fromMe: true, no
    // participant, and the DM peer's jid in remoteJid (not ours). Using
    // remoteJid as the voter identity for the crypto call — instead of our
    // own identity — fails GCM authentication and the vote is silently
    // dropped (decrypt throws, caught, returns undefined).
    const DM_PEER_JID = "15550003333@s.whatsapp.net";
    const { message: pollCreationMessage, pollEncKey } = buildPollCreationMessageForTests({
      section: "pollCreationMessage",
      options: ["Yes", "No"],
    });
    const creationKey: WAMessageKey = {
      remoteJid: DM_PEER_JID,
      id: POLL_MSG_ID,
      fromMe: true,
    };
    const vote = encryptPollVoteForTests({
      selectedOptionNames: ["Yes"],
      pollEncKey,
      pollCreatorJid: POLL_CREATOR_JID,
      pollMsgId: POLL_MSG_ID,
      voterJid: POLL_CREATOR_JID,
    });
    const voteMessage = buildPollUpdateMessageForTests({ creationKey, vote });

    const decoded = decodeWhatsAppPollVote({
      message: voteMessage,
      key: {
        remoteJid: DM_PEER_JID,
        id: "VOTE-SELF-DM",
        fromMe: true,
      } as proto.IMessageKey,
      getCachedMessage: (remoteJid, messageId) =>
        remoteJid === DM_PEER_JID && messageId === POLL_MSG_ID ? pollCreationMessage : undefined,
      selfJid: POLL_CREATOR_JID,
    });

    expect(decoded?.selectedOptions).toEqual(["Yes"]);
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

describe("maybeEmitWhatsAppPollVoteReceivedHook", () => {
  beforeEach(() => {
    hasHooksMock.mockClear();
    pollVoteWarningMock.mockClear();
    runPollVoteReceivedMock.mockClear();
  });

  it("records one redacted non-outcome when an owned poll's cached creation message expired", () => {
    const pollMessageId = "POLL-CACHE-EXPIRED";
    const { pollEncKey } = buildPollCreationMessageForTests({
      section: "pollCreationMessage",
      options: ["A", "B"],
    });
    const creationKey = creationKeyFor(pollMessageId);
    const vote = encryptPollVoteForTests({
      selectedOptionNames: ["A"],
      pollEncKey,
      pollCreatorJid: POLL_CREATOR_JID,
      pollMsgId: pollMessageId,
      voterJid: VOTER_JID,
    });
    const voteMessage = buildPollUpdateMessageForTests({ creationKey, vote });
    const cfg = {
      channels: { whatsapp: { pluginHooks: { pollVoteReceived: true } } },
    } as never;
    const params = {
      cfg,
      accountId: "default",
      message: voteMessage,
      key: voteKeyFor("VOTE-CACHE-EXPIRED"),
      getCachedMessage: () => undefined,
      selfJid: POLL_CREATOR_JID,
    };

    rememberWhatsAppOwnPollCreation("default", CHAT_JID, pollMessageId);
    maybeEmitWhatsAppPollVoteReceivedHook(params);
    maybeEmitWhatsAppPollVoteReceivedHook(params);

    expect(pollVoteWarningMock).toHaveBeenCalledTimes(1);
    expect(pollVoteWarningMock).toHaveBeenCalledWith(
      "whatsapp poll_vote_received not dispatched: locally created poll could not be decoded",
    );
    expect(runPollVoteReceivedMock).not.toHaveBeenCalled();
  });

  it("keeps undecodable third-party polls silent", () => {
    const creationKey = {
      remoteJid: CHAT_JID,
      id: "POLL-THIRD-PARTY",
      fromMe: false,
      participant: POLL_CREATOR_JID,
    };
    const voteMessage = buildPollUpdateMessageForTests({
      creationKey,
      vote: { encPayload: new Uint8Array([1]), encIv: new Uint8Array([2]) },
    });

    maybeEmitWhatsAppPollVoteReceivedHook({
      cfg: { channels: { whatsapp: { pluginHooks: { pollVoteReceived: true } } } } as never,
      accountId: "default",
      message: voteMessage,
      key: voteKeyFor("VOTE-THIRD-PARTY"),
      getCachedMessage: () => undefined,
      selfJid: POLL_CREATOR_JID,
    });

    expect(pollVoteWarningMock).not.toHaveBeenCalled();
  });
});
