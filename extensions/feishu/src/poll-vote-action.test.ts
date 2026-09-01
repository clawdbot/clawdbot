// Feishu tests cover poll vote card action behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeishuCardInteractionEnvelope } from "./card-interaction.js";
import { handleFeishuPollVoteAction } from "./poll-vote-action.js";
import {
  buildFeishuPollCard,
  createFeishuPollStoreState,
  FEISHU_POLL_VOTE_ACTION,
} from "./polls.js";
import { setFeishuRuntime } from "./runtime.js";
import { feishuRuntimeStub } from "./test-support/runtime.js";

const editMessageFeishu = vi.hoisted(() => vi.fn());
vi.mock("./send.js", () => ({ editMessageFeishu }));

function createIsolatedPollStore() {
  // The action under test builds its store with no options, resolving the state
  // dir from OPENCLAW_STATE_DIR; point it at a fresh temp dir so the test's own
  // store instance observes the same SQLite file as the action's writes.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-feishu-poll-vote-"));
  process.env.OPENCLAW_STATE_DIR = home;
  return { home, store: createFeishuPollStoreState() };
}

function voteEnvelope(pollId: string, optionIndex: string): FeishuCardInteractionEnvelope {
  return { oc: "ocf1", k: "button", a: FEISHU_POLL_VOTE_ACTION, m: { p: pollId, o: optionIndex } };
}

function makeEvent(openId: string) {
  return {
    operator: { open_id: openId },
    token: "tok",
    action: { value: {}, tag: "button" },
    context: {},
  };
}

describe("feishu poll vote card action", () => {
  beforeEach(() => {
    setFeishuRuntime(feishuRuntimeStub);
    editMessageFeishu
      .mockReset()
      .mockResolvedValue({ messageId: "msg", contentType: "interactive" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENCLAW_STATE_DIR;
  });

  it("records a single-select vote and re-renders the card with live tallies", async () => {
    const { store } = createIsolatedPollStore();
    await store.createPoll({
      id: "poll-a",
      question: "Pick one",
      options: ["A", "B"],
      maxSelections: 1,
      messageId: "msg-a",
      createdAt: new Date().toISOString(),
      votes: {},
    });

    const outcome = await handleFeishuPollVoteAction({
      cfg: { channels: {} },
      event: makeEvent("ou_voter"),
      envelope: voteEnvelope("poll-a", "0"),
      log: () => {},
    });

    expect(outcome).toBe("handled");
    const stored = await store.getPoll("poll-a");
    expect(stored?.votes["ou_voter"]).toEqual(["0"]);
    expect(editMessageFeishu).toHaveBeenCalledTimes(1);
    const updateCard = editMessageFeishu.mock.calls[0][0].card;
    expect(updateCard).toEqual(
      buildFeishuPollCard({
        pollId: "poll-a",
        question: "Pick one",
        options: ["A", "B"],
        maxSelections: 1,
        chatId: undefined,
        votes: { ou_voter: ["0"] },
        voterOpenId: "ou_voter",
      }),
    );
  });

  it("toggles multi-select votes up to maxSelections", async () => {
    const { store } = createIsolatedPollStore();
    await store.createPoll({
      id: "poll-multi",
      question: "Pick two",
      options: ["A", "B", "C"],
      maxSelections: 2,
      messageId: "msg-multi",
      createdAt: new Date().toISOString(),
      votes: {},
    });

    await handleFeishuPollVoteAction({
      cfg: { channels: {} },
      event: makeEvent("ou_voter"),
      envelope: voteEnvelope("poll-multi", "0"),
      log: () => {},
    });
    await handleFeishuPollVoteAction({
      cfg: { channels: {} },
      event: makeEvent("ou_voter"),
      envelope: voteEnvelope("poll-multi", "1"),
      log: () => {},
    });
    let stored = await store.getPoll("poll-multi");
    expect(stored?.votes["ou_voter"]).toEqual(["0", "1"]);

    // Tapping "0" again removes it (toggle), leaving only "1".
    await handleFeishuPollVoteAction({
      cfg: { channels: {} },
      event: makeEvent("ou_voter"),
      envelope: voteEnvelope("poll-multi", "0"),
      log: () => {},
    });
    stored = await store.getPoll("poll-multi");
    expect(stored?.votes["ou_voter"]).toEqual(["1"]);
  });

  it("ignores votes for unknown polls without re-rendering", async () => {
    const outcome = await handleFeishuPollVoteAction({
      cfg: { channels: {} },
      event: makeEvent("ou_voter"),
      envelope: voteEnvelope("poll-missing", "0"),
      log: () => {},
    });
    expect(outcome).toBe("ignored");
    expect(editMessageFeishu).not.toHaveBeenCalled();
  });
});
