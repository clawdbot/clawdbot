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
// Matches the mock sock's `user.id` default in monitor-inbox.test-harness.ts —
// the poll_vote_received hook only fires for polls this account created.
const SELF_JID = "123@s.whatsapp.net";
const OTHER_CREATOR_JID = "111@s.whatsapp.net";
const VOTER_JID = "222@s.whatsapp.net";

describe("web monitor inbox poll vote hook", () => {
  installStreamsInboundMessageHooks();

  async function emitPollAndVote(params: {
    baileysCache: ReturnType<typeof createBaileysCacheSupport>;
    /** Whether this account created the poll (default true). false simulates a third-party poll. */
    pollCreatorIsSelf?: boolean;
    /**
     * The poll-creation and vote-update message ids. The ownership and
     * redelivery-dedup caches are module-scoped singletons (matching
     * production: both must survive across `messages.upsert` calls within
     * one connection), so each test needs its own ids to avoid colliding
     * with another test's cache entries.
     */
    pollMessageId: string;
    voteMessageId: string;
  }) {
    const pollCreatorIsSelf = params.pollCreatorIsSelf ?? true;
    const { pollMessageId, voteMessageId } = params;
    const { message: pollCreationMessage, pollEncKey } = buildPollCreationMessageForTests({
      section: "pollCreationMessage",
      options: ["Pizza", "Sushi"],
    });
    const creationKey = pollCreatorIsSelf
      ? { remoteJid: CHAT_JID, id: pollMessageId, fromMe: true }
      : { remoteJid: CHAT_JID, id: pollMessageId, fromMe: false, participant: OTHER_CREATOR_JID };

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
      expect(params.baileysCache.recentMessageKeys.has(`${CHAT_JID}:${pollMessageId}`)).toBe(true);
    });

    const vote = encryptPollVoteForTests({
      selectedOptionNames: ["Sushi"],
      pollEncKey,
      pollCreatorJid: pollCreatorIsSelf ? SELF_JID : OTHER_CREATOR_JID,
      pollMsgId: pollMessageId,
      voterJid: VOTER_JID,
    });
    const voteMessage = buildPollUpdateMessageForTests({
      creationKey,
      vote,
      senderTimestampMs: 1_700_000_100_000,
    });
    const voteUpsert = {
      type: "notify",
      messages: [
        {
          key: { remoteJid: CHAT_JID, id: voteMessageId, fromMe: false, participant: VOTER_JID },
          message: voteMessage,
          messageTimestamp: 1_700_000_100,
        },
      ],
    };
    sock.ev.emit("messages.upsert", voteUpsert);
    return { sock, voteUpsert };
  }

  it("does not fire poll_vote_received when the opt-in gate is off (default)", async () => {
    mockLoadConfig.mockReturnValue({
      channels: { whatsapp: { allowFrom: ["*"] } },
    });
    const baileysCache = createBaileysCacheSupport();

    await emitPollAndVote({
      baileysCache,
      pollMessageId: "POLL-GATE-OFF",
      voteMessageId: "VOTE-GATE-OFF",
    });
    // Give the fire-and-forget dispatch a tick to (not) run.
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

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
    const pollMessageId = "POLL-HAPPY-PATH";

    await emitPollAndVote({ baileysCache, pollMessageId, voteMessageId: "VOTE-HAPPY-PATH" });
    await waitForMessageCalls(runPollVoteReceivedMock, 1);

    expect(runPollVoteReceivedMock).toHaveBeenCalledWith(
      {
        pollMessageId,
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
        messageId: pollMessageId,
      },
    );
  });

  it("does not fire poll_vote_received for a poll this account did not create, even when enabled", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          pluginHooks: { pollVoteReceived: true },
        },
      },
    });
    const baileysCache = createBaileysCacheSupport();

    await emitPollAndVote({
      baileysCache,
      pollCreatorIsSelf: false,
      pollMessageId: "POLL-THIRD-PARTY",
      voteMessageId: "VOTE-THIRD-PARTY",
    });
    // Give the fire-and-forget dispatch a tick to (not) run.
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(runPollVoteReceivedMock).not.toHaveBeenCalled();
  });

  it("does not fire poll_vote_received twice for a redelivered vote-update upsert", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          pluginHooks: { pollVoteReceived: true },
        },
      },
    });
    const baileysCache = createBaileysCacheSupport();

    const { sock, voteUpsert } = await emitPollAndVote({
      baileysCache,
      pollMessageId: "POLL-REDELIVERY",
      voteMessageId: "VOTE-REDELIVERY",
    });
    await waitForMessageCalls(runPollVoteReceivedMock, 1);

    // Simulate WhatsApp redelivering the same messages.upsert (e.g. after a
    // brief reconnect) with the identical vote-update message key.
    sock.ev.emit("messages.upsert", voteUpsert);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(runPollVoteReceivedMock).toHaveBeenCalledTimes(1);
  });
});
