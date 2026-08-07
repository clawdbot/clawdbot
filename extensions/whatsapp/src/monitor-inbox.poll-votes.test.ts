// WhatsApp monitor inbox poll-vote hook behavior.
import { describe, expect, it, vi } from "vitest";
import {
  maybeEmitWhatsAppPollVoteReceivedHook,
  rememberWhatsAppOwnPollCreation,
  rememberWhatsAppPollCreationMessage,
} from "./inbound/poll-votes.js";
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
  DEFAULT_ACCOUNT_ID,
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
    /** Wraps the vote-update message in an ephemeralMessage envelope, as WhatsApp does for disappearing-message chats. */
    wrapVoteInEphemeral?: boolean;
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
    if (pollCreatorIsSelf) {
      // Ownership is only ever recorded from the accepted-send path (see
      // send.ts), never inferred from the fromMe echo emitted above — that
      // echo alone must NOT be sufficient to establish ownership (a fromMe
      // poll-creation message can also come from another linked device).
      // Simulate what sendPollWhatsApp would have done at accepted-send time.
      const cfg = mockLoadConfig() as never;
      rememberWhatsAppOwnPollCreation(DEFAULT_ACCOUNT_ID, CHAT_JID, pollMessageId, cfg);
      rememberWhatsAppPollCreationMessage(
        DEFAULT_ACCOUNT_ID,
        CHAT_JID,
        pollMessageId,
        pollCreationMessage,
        cfg,
      );
    }

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
    const dispatchedVoteMessage = params.wrapVoteInEphemeral
      ? { ephemeralMessage: { message: voteMessage } }
      : voteMessage;
    const voteUpsert = {
      type: "notify",
      messages: [
        {
          key: { remoteJid: CHAT_JID, id: voteMessageId, fromMe: false, participant: VOTER_JID },
          message: dispatchedVoteMessage,
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
    const voteMessageId = "VOTE-HAPPY-PATH";

    await emitPollAndVote({ baileysCache, pollMessageId, voteMessageId });
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
        // The vote-update's own id, not the poll creation id — distinct
        // per vote/retraction so consumers can correlate individual events.
        messageId: voteMessageId,
      },
    );
  });

  it("fires poll_vote_received for a vote update wrapped in an ephemeralMessage envelope", async () => {
    // Regression: the dispatch gate used to check msg.message.pollUpdateMessage
    // directly, bypassing the same wrapper-unwrapping the extractor already
    // applies to poll creation messages — a vote arriving inside a
    // disappearing-message envelope was silently dropped.
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          pluginHooks: { pollVoteReceived: true },
        },
      },
    });
    const baileysCache = createBaileysCacheSupport();
    const pollMessageId = "POLL-WRAPPED";
    const voteMessageId = "VOTE-WRAPPED";

    await emitPollAndVote({
      baileysCache,
      pollMessageId,
      voteMessageId,
      wrapVoteInEphemeral: true,
    });
    await waitForMessageCalls(runPollVoteReceivedMock, 1);

    expect(runPollVoteReceivedMock).toHaveBeenCalledWith(
      expect.objectContaining({ pollMessageId, selectedOptions: ["Sushi"] }),
      expect.anything(),
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

  it("does not fire poll_vote_received for a fromMe poll-creation echo that was never an accepted OpenClaw send (linked-device poll)", async () => {
    // Regression: a fromMe poll-creation message can also originate from
    // another device linked to the same WhatsApp account — the gateway
    // never sent it. Only an actual accepted send (send.ts) may establish
    // ownership; observing the fromMe echo alone must not.
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          pluginHooks: { pollVoteReceived: true },
        },
      },
    });
    const baileysCache = createBaileysCacheSupport();
    const pollMessageId = "POLL-LINKED-DEVICE";
    const voteMessageId = "VOTE-LINKED-DEVICE";
    const { message: pollCreationMessage, pollEncKey } = buildPollCreationMessageForTests({
      section: "pollCreationMessage",
      options: ["Pizza", "Sushi"],
    });
    const creationKey = { remoteJid: CHAT_JID, id: pollMessageId, fromMe: true };

    const { sock } = await startInboxMonitor(vi.fn(async () => {}) as InboxOnMessage, {
      recentMessageKeys: baileysCache.recentMessageKeys,
      baileysGroupMetaCache: baileysCache.baileysGroupMetaCache,
    });
    // A fromMe poll-creation echo arrives, but no matching accepted send was
    // ever recorded (rememberWhatsAppOwnPollCreation was never called) —
    // simulates a poll created manually from another linked device.
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        { key: creationKey, message: pollCreationMessage, messageTimestamp: 1_700_000_000 },
      ],
    });
    await vi.waitFor(() => {
      expect(baileysCache.recentMessageKeys.has(`${CHAT_JID}:${pollMessageId}`)).toBe(true);
    });

    const vote = encryptPollVoteForTests({
      selectedOptionNames: ["Sushi"],
      pollEncKey,
      pollCreatorJid: SELF_JID,
      pollMsgId: pollMessageId,
      voterJid: VOTER_JID,
    });
    const voteMessage = buildPollUpdateMessageForTests({ creationKey, vote });
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: CHAT_JID, id: voteMessageId, fromMe: false, participant: VOTER_JID },
          message: voteMessage,
          messageTimestamp: 1_700_000_100,
        },
      ],
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

  // Precedence of the channel.pluginHooks.pollVoteReceived opt-in vs. its
  // per-account override — exercised end to end (not as an isolated unit
  // test of the gate function) so the check stays a real production
  // consumer of the gate logic instead of an orphaned test-only export.
  it("fires when an account-level override enables it despite channel-level being off", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          pluginHooks: { pollVoteReceived: false },
          accounts: { [DEFAULT_ACCOUNT_ID]: { pluginHooks: { pollVoteReceived: true } } },
        },
      },
    });
    const baileysCache = createBaileysCacheSupport();

    await emitPollAndVote({
      baileysCache,
      pollMessageId: "POLL-ACCOUNT-OVERRIDE-ON",
      voteMessageId: "VOTE-ACCOUNT-OVERRIDE-ON",
    });

    await waitForMessageCalls(runPollVoteReceivedMock, 1);
  });

  it("does not fire when an account-level override disables it despite channel-level being on", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          pluginHooks: { pollVoteReceived: true },
          accounts: { [DEFAULT_ACCOUNT_ID]: { pluginHooks: { pollVoteReceived: false } } },
        },
      },
    });
    const baileysCache = createBaileysCacheSupport();

    await emitPollAndVote({
      baileysCache,
      pollMessageId: "POLL-ACCOUNT-OVERRIDE-OFF",
      voteMessageId: "VOTE-ACCOUNT-OVERRIDE-OFF",
    });
    // Give the fire-and-forget dispatch a tick to (not) run.
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(runPollVoteReceivedMock).not.toHaveBeenCalled();
  });

  it("falls back to the channel-level setting when the account has no override", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          pluginHooks: { pollVoteReceived: true },
          accounts: { [DEFAULT_ACCOUNT_ID]: {} },
        },
      },
    });
    const baileysCache = createBaileysCacheSupport();

    await emitPollAndVote({
      baileysCache,
      pollMessageId: "POLL-ACCOUNT-FALLBACK",
      voteMessageId: "VOTE-ACCOUNT-FALLBACK",
    });

    await waitForMessageCalls(runPollVoteReceivedMock, 1);
  });

  // Exercises maybeEmitWhatsAppPollVoteReceivedHook/rememberWhatsAppOwnPollCreation
  // directly (rather than through a mock socket) to prove ownership is scoped
  // per WhatsApp account: with multiple connected accounts possibly observing
  // the same group, an unscoped cache key would let one account's poll
  // ownership leak another account's vote data through its opted-in hook.
  describe("cross-account isolation", () => {
    const ACCOUNT_A = "account-a";
    const ACCOUNT_B = "account-b";

    function buildOwnPollAndVote(pollMessageId: string, voteMessageId: string) {
      const { message: pollCreationMessage, pollEncKey } = buildPollCreationMessageForTests({
        section: "pollCreationMessage",
        options: ["Pizza", "Sushi"],
      });
      const creationKey = { remoteJid: CHAT_JID, id: pollMessageId, fromMe: true };
      const vote = encryptPollVoteForTests({
        selectedOptionNames: ["Sushi"],
        pollEncKey,
        pollCreatorJid: SELF_JID,
        pollMsgId: pollMessageId,
        voterJid: VOTER_JID,
      });
      const voteMessage = buildPollUpdateMessageForTests({
        creationKey,
        vote,
        senderTimestampMs: 1_700_000_100_000,
      });
      return {
        pollCreationMessage,
        voteKey: { remoteJid: CHAT_JID, id: voteMessageId, fromMe: false, participant: VOTER_JID },
        voteMessage,
      };
    }

    it("does not fire for another account's poll even when that account marked ownership", async () => {
      const pollMessageId = "POLL-CROSS-ACCOUNT";
      const { pollCreationMessage, voteKey, voteMessage } = buildOwnPollAndVote(
        pollMessageId,
        "VOTE-CROSS-ACCOUNT",
      );
      const cfg = {
        channels: {
          whatsapp: { allowFrom: ["*"], pluginHooks: { pollVoteReceived: true } },
        },
      } as never;
      // Only account A observed (and recorded) this poll as its own.
      rememberWhatsAppOwnPollCreation(ACCOUNT_A, CHAT_JID, pollMessageId, cfg);

      // Account B, opted in, observes a vote on the same chat/poll id — must
      // not fire, since B never recorded this poll as its own.
      maybeEmitWhatsAppPollVoteReceivedHook({
        cfg,
        accountId: ACCOUNT_B,
        message: voteMessage,
        key: voteKey,
        getCachedMessage: () => pollCreationMessage,
        selfJid: SELF_JID,
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(runPollVoteReceivedMock).not.toHaveBeenCalled();

      // The same vote, dispatched as account A (the actual owner), does fire.
      maybeEmitWhatsAppPollVoteReceivedHook({
        cfg,
        accountId: ACCOUNT_A,
        message: voteMessage,
        key: voteKey,
        getCachedMessage: () => pollCreationMessage,
        selfJid: SELF_JID,
      });
      await waitForMessageCalls(runPollVoteReceivedMock, 1);
    });
  });
});
