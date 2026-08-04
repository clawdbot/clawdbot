// WhatsApp monitor inbox poll-vote hook behavior.
import { describe, expect, it, vi } from "vitest";
import {
  buildPollCreationMessageForTests,
  buildPollUpdateMessageForTests,
  encryptPollVoteForTests,
} from "./inbound/poll-votes.test-support.js";
import {
  createBaileysCacheSupport,
  installStreamsInboundMessageHooks,
} from "./monitor-inbox.streams-inbound-messages.test-support.js";
import {
  mockLoadConfig,
  startInboxMonitor,
  waitForMessageCalls,
  type InboxOnMessage,
} from "./monitor-inbox.test-harness.js";

const { runPollVoteReceivedMock } = vi.hoisted(() => ({
  runPollVoteReceivedMock: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (hookName: string) => hookName === "poll_vote_received",
    runPollVoteReceived: runPollVoteReceivedMock,
  }),
}));

const CHAT_JID = "999@s.whatsapp.net";
const POLL_CREATOR_JID = "111@s.whatsapp.net";
const VOTER_JID = "222@s.whatsapp.net";
const POLL_MSG_ID = "POLL-CREATION-1";

describe("web monitor inbox poll vote hook", () => {
  installStreamsInboundMessageHooks();

  async function emitPollAndVote(params: {
    baileysCache: ReturnType<typeof createBaileysCacheSupport>;
  }) {
    const { message: pollCreationMessage, pollEncKey } = buildPollCreationMessageForTests({
      section: "pollCreationMessage",
      options: ["Pizza", "Sushi"],
    });
    const creationKey = {
      remoteJid: CHAT_JID,
      id: POLL_MSG_ID,
      fromMe: false,
      participant: POLL_CREATOR_JID,
    };

    const { sock } = await startInboxMonitor(vi.fn(async () => {}) as InboxOnMessage, {
      recentMessageKeys: params.baileysCache.recentMessageKeys,
      baileysGroupMetaCache: params.baileysCache.baileysGroupMetaCache,
    });

    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        { key: creationKey, message: pollCreationMessage, messageTimestamp: 1_700_000_000 },
      ],
    });
    await vi.waitFor(() => {
      expect(params.baileysCache.recentMessageKeys.has(`${CHAT_JID}:${POLL_MSG_ID}`)).toBe(true);
    });

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
      senderTimestampMs: 1_700_000_100_000,
    });
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: CHAT_JID, id: "VOTE-1", fromMe: false, participant: VOTER_JID },
          message: voteMessage,
          messageTimestamp: 1_700_000_100,
        },
      ],
    });
  }

  it("does not fire poll_vote_received when the opt-in gate is off (default)", async () => {
    mockLoadConfig.mockReturnValue({
      channels: { whatsapp: { allowFrom: ["*"] } },
    });
    const baileysCache = createBaileysCacheSupport();

    await emitPollAndVote({ baileysCache });
    // Give the fire-and-forget dispatch a tick to (not) run.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runPollVoteReceivedMock).not.toHaveBeenCalled();
  });

  it("fires poll_vote_received with the correctly decoded vote when enabled", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          pluginHooks: { pollVoteReceived: true },
        },
      },
    });
    const baileysCache = createBaileysCacheSupport();

    await emitPollAndVote({ baileysCache });
    await waitForMessageCalls(runPollVoteReceivedMock, 1);

    expect(runPollVoteReceivedMock).toHaveBeenCalledWith(
      {
        pollMessageId: POLL_MSG_ID,
        chatJid: CHAT_JID,
        voter: VOTER_JID,
        selectedOptions: ["Sushi"],
        timestamp: 1_700_000_100_000,
      },
      {
        channelId: "whatsapp",
        accountId: "default",
        conversationId: CHAT_JID,
        senderId: VOTER_JID,
        messageId: POLL_MSG_ID,
      },
    );
  });
});
