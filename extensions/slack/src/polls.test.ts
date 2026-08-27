// Slack tests cover native poll block rendering, action decoding, and store
// persistence (create/readback/record-vote).
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSlackPollMessage,
  createSlackPollStoreState,
  decodeSlackPollVoteAction,
} from "./polls.js";
import { SLACK_POLL_VOTE_ACTION_ID } from "./reply-action-ids.js";
import { setSlackRuntime } from "./runtime.js";

describe("slack polls block rendering", () => {
  it("renders a question, one button per option with a tally, and a context hint", () => {
    const built = buildSlackPollMessage({
      question: "Pick a language",
      options: ["TypeScript", "Rust"],
      maxSelections: 1,
      votes: { userA: ["0"], userB: ["1"], userC: ["0"] },
    });
    expect(built.text).toBe("Poll: Pick a language");
    expect(built.pollId).toBeTruthy();

    const section = built.blocks[0] as { type: string; text: { text: string } };
    expect(section.type).toBe("section");
    expect(section.text.text).toBe("Pick a language");

    const actions = built.blocks[1] as { type: string; elements: unknown[] };
    expect(actions.type).toBe("actions");
    expect(actions.elements).toHaveLength(2);
    const [first, second] = actions.elements as Array<{
      type: string;
      text: { text: string };
      value: string;
      action_id: string;
    }>;
    expect(first!.type).toBe("button");
    expect(first!.text.text).toBe("TypeScript (2)");
    expect(first!.value).toBe("0");
    expect(first!.action_id).toBe(`${SLACK_POLL_VOTE_ACTION_ID}:${built.pollId}`);
    expect(second!.text.text).toBe("Rust (1)");
    expect(second!.value).toBe("1");

    const context = built.blocks[2] as { type: string; elements: [{ text: string }] };
    expect(context.type).toBe("context");
    expect(context.elements[0]!.text).toContain("3 voted.");
  });

  it("suggests a selection limit when maxSelections exceeds one", () => {
    const built = buildSlackPollMessage({
      question: "Top two",
      options: ["A", "B", "C"],
      maxSelections: 2,
    });
    const context = built.blocks[2] as { type: string; elements: [{ text: string }] };
    expect(context.elements[0]!.text).toContain("Select up to 2 options.");
  });

  it("caps rendered option buttons at the Slack poll option limit", () => {
    const tooMany = Array.from({ length: 30 }, (_, index) => `Option ${index}`);
    const built = buildSlackPollMessage({
      question: "Too many",
      options: tooMany,
      maxSelections: 1,
    });
    const actions = built.blocks[1] as { type: string; elements: unknown[] };
    expect(actions.elements).toHaveLength(20);
  });

  it("truncates question and option labels to Slack Block Kit field limits", () => {
    const longQuestion = "Q".repeat(3_500);
    const longOption = "O".repeat(100);
    const built = buildSlackPollMessage({
      question: longQuestion,
      options: [longOption],
      maxSelections: 1,
    });
    const section = built.blocks[0] as { type: string; text: { text: string } };
    expect(section.text.text.length).toBeLessThanOrEqual(3_000);
    expect(section.text.text).toMatch(/…$/);
    const actions = built.blocks[1] as {
      type: string;
      elements: Array<{ text: { text: string } }>;
    };
    expect(actions.elements[0]!.text.text.length).toBeLessThanOrEqual(75);
    expect(actions.elements[0]!.text.text).toMatch(/…$/);
  });

  it("keeps shared poll blocks voter-neutral across vote callbacks", () => {
    const built = buildSlackPollMessage({
      question: "Pick",
      options: ["A", "B"],
      maxSelections: 2,
      votes: { userA: ["0"] },
    });
    const actions = built.blocks[1] as {
      type: string;
      elements: Array<{ text: { text: string } }>;
    };
    // chat.update replaces the common message, so no per-voter checkmark may
    // appear on any button — every viewer sees the same tally-only blocks.
    expect(actions.elements[0]!.text.text).not.toContain("✓");
    expect(actions.elements[1]!.text.text).not.toContain("✓");
  });

  it("decodes only poll vote action ids that carry a poll id and option", () => {
    const pollId = "poll-1";
    expect(decodeSlackPollVoteAction(`${SLACK_POLL_VOTE_ACTION_ID}:${pollId}`, "3")).toEqual({
      pollId,
      optionIndex: "3",
    });
    expect(decodeSlackPollVoteAction(`${SLACK_POLL_VOTE_ACTION_ID}:${pollId}`, 2)).toEqual({
      pollId,
      optionIndex: "2",
    });
    expect(decodeSlackPollVoteAction(`${SLACK_POLL_VOTE_ACTION_ID}:`, "0")).toBeNull();
    expect(decodeSlackPollVoteAction("unrelated:button", "0")).toBeNull();
    expect(decodeSlackPollVoteAction(`${SLACK_POLL_VOTE_ACTION_ID}:${pollId}`, "")).toBeNull();
  });
});

describe("slack polls store", () => {
  afterEach(() => {
    setSlackRuntime(null as never);
    vi.restoreAllMocks();
  });

  it("creates a poll, reads it back, and tallies votes read by option", async () => {
    await withOpenClawTestState(
      { label: "slack-polls-create", layout: "state-only", applyEnv: false },
      async (state) => {
        const openKeyedStore = vi.fn((options: { namespace: string; maxEntries: number }) =>
          createPluginStateKeyedStoreForTests("slack", { ...options, env: state.env }),
        );
        setSlackRuntime({
          state: { openKeyedStore, resolveStateDir: () => state.root },
          logging: { getChildLogger: () => ({ warn: vi.fn() }) },
        } as never);

        const store = createSlackPollStoreState();
        const poll = {
          id: "poll-1",
          question: "Best language?",
          options: ["TypeScript", "Rust"],
          maxSelections: 1,
          createdAt: new Date().toISOString(),
          conversationId: "C123",
          messageId: "1700000000.000001",
          votes: {},
        };
        await store.createPoll(poll);

        await expect(store.getPoll("poll-1")).resolves.toEqual(
          expect.objectContaining({ question: "Best language?", options: ["TypeScript", "Rust"] }),
        );

        const updated = await store.recordVote({
          pollId: "poll-1",
          voterId: "userA",
          selections: ["0"],
        });
        expect(updated?.poll.votes).toEqual({ userA: ["0"] });
        expect(updated?.capped).toBe(false);

        await store.recordVote({ pollId: "poll-1", voterId: "userB", selections: ["1"] });
        await expect(store.getPoll("poll-1")).resolves.toEqual(
          expect.objectContaining({ votes: { userA: ["0"], userB: ["1"] } }),
        );
      },
    );
  });

  it("replaces a voter's prior selections and bounds them to maxSelections", async () => {
    await withOpenClawTestState(
      { label: "slack-polls-reselect", layout: "state-only", applyEnv: false },
      async (state) => {
        const openKeyedStore = vi.fn((options: { namespace: string; maxEntries: number }) =>
          createPluginStateKeyedStoreForTests("slack", { ...options, env: state.env }),
        );
        setSlackRuntime({
          state: { openKeyedStore, resolveStateDir: () => state.root },
          logging: { getChildLogger: () => ({ warn: vi.fn() }) },
        } as never);

        const store = createSlackPollStoreState();
        await store.createPoll({
          id: "poll-2",
          question: "q",
          options: ["A", "B", "C"],
          maxSelections: 1,
          createdAt: new Date().toISOString(),
          votes: {},
        });

        await store.recordVote({ pollId: "poll-2", voterId: "u", selections: ["0"] });
        const after = await store.recordVote({ pollId: "poll-2", voterId: "u", selections: ["1"] });
        // A single candidate may vote for at most maxSelections distinct options.
        expect(after?.poll.votes).toEqual({ u: ["1"] });
      },
    );
  });

  it("returns null when recording a vote for an unknown or expired poll", async () => {
    await withOpenClawTestState(
      { label: "slack-polls-unknown", layout: "state-only", applyEnv: false },
      async (state) => {
        const openKeyedStore = vi.fn((options: { namespace: string; maxEntries: number }) =>
          createPluginStateKeyedStoreForTests("slack", { ...options, env: state.env }),
        );
        setSlackRuntime({
          state: { openKeyedStore, resolveStateDir: () => state.root },
          logging: { getChildLogger: () => ({ warn: vi.fn() }) },
        } as never);

        const store = createSlackPollStoreState();
        await expect(
          store.recordVote({ pollId: "missing", voterId: "u", selections: ["0"] }),
        ).resolves.toBeNull();
      },
    );
  });

  it("toggles multi-select votes so a voter can retain more than one option", async () => {
    await withOpenClawTestState(
      { label: "slack-polls-multiselect", layout: "state-only", applyEnv: false },
      async (state) => {
        const openKeyedStore = vi.fn((options: { namespace: string; maxEntries: number }) =>
          createPluginStateKeyedStoreForTests("slack", { ...options, env: state.env }),
        );
        setSlackRuntime({
          state: { openKeyedStore, resolveStateDir: () => state.root },
          logging: { getChildLogger: () => ({ warn: vi.fn() }) },
        } as never);

        const store = createSlackPollStoreState();
        await store.createPoll({
          id: "poll-multi",
          question: "Pick two",
          options: ["A", "B", "C"],
          maxSelections: 2,
          createdAt: new Date().toISOString(),
          votes: {},
        });

        const first = await store.recordVote({
          pollId: "poll-multi",
          voterId: "u",
          selections: ["0"],
          mode: "toggle",
        });
        expect(first?.poll.votes).toEqual({ u: ["0"] });

        // A second distinct option is added, not replacing the first.
        const second = await store.recordVote({
          pollId: "poll-multi",
          voterId: "u",
          selections: ["1"],
          mode: "toggle",
        });
        expect(second?.poll.votes).toEqual({ u: ["0", "1"] });
        expect(second?.capped).toBe(false);

        // A third option exceeds maxSelections and is refused; prior set intact.
        const third = await store.recordVote({
          pollId: "poll-multi",
          voterId: "u",
          selections: ["2"],
          mode: "toggle",
        });
        expect(third?.poll.votes).toEqual({ u: ["0", "1"] });
        expect(third?.capped).toBe(true);

        // Re-toggling an already-selected option removes it.
        const removed = await store.recordVote({
          pollId: "poll-multi",
          voterId: "u",
          selections: ["0"],
          mode: "toggle",
        });
        expect(removed?.poll.votes).toEqual({ u: ["1"] });
        expect(removed?.capped).toBe(false);
      },
    );
  });
});
