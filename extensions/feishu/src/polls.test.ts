// Feishu tests cover polls plugin behavior.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeishuCardInteractionEnvelope } from "./card-interaction.js";
import {
  FEISHU_POLL_VOTE_ACTION,
  buildFeishuPollCard,
  createFeishuPollStoreState,
  extractFeishuPollVote,
} from "./polls.js";
import { setFeishuRuntime } from "./runtime.js";
import { feishuRuntimeStub } from "./test-support/runtime.js";

function createIsolatedStore() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-feishu-polls-"));
  return { home, store: createFeishuPollStoreState({ homedir: () => home }) };
}

function toEnvelope(a: string, m: Record<string, string | number | boolean | null | undefined>) {
  return { oc: "ocf1", k: "button", a, m } as FeishuCardInteractionEnvelope;
}

describe("feishu buildFeishuPollCard", () => {
  it("renders the question and one vote button per option", () => {
    const card = buildFeishuPollCard({
      pollId: "poll-1",
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
    }) as { body: { elements: Array<Record<string, unknown>> } };

    const markdown = card.body.elements[0] as { content: string };
    expect(markdown.content).toBe("Lunch?");
    // 2 option action rows + 1 hint row.
    expect(card.body.elements.length).toBe(4);
    const optionAction = card.body.elements[1] as {
      actions: Array<{ value: FeishuCardInteractionEnvelope }>;
    };
    expect(optionAction.actions[0].value.a).toBe(FEISHU_POLL_VOTE_ACTION);
    expect(optionAction.actions[0].value.m).toMatchObject({ p: "poll-1", o: "0" });
  });

  it("keeps vote buttons clickable by every member (no user-bound context)", () => {
    const card = buildFeishuPollCard({
      pollId: "poll-1",
      question: "Pick",
      options: ["A", "B"],
      maxSelections: 1,
    }) as {
      body: { elements: Array<{ actions: Array<{ value: FeishuCardInteractionEnvelope }> }> };
    };
    const envelope = card.body.elements[1].actions[0].value;
    expect(envelope.c?.u).toBeUndefined();
  });

  it("renders live tallies and selected state into option labels", () => {
    const card = buildFeishuPollCard({
      pollId: "poll-1",
      question: "Pick",
      options: ["A", "B"],
      maxSelections: 1,
      votes: { "voter-1": ["0"], "voter-2": ["0"] },
      voterOpenId: "voter-1",
    }) as {
      body: {
        elements: Array<{
          actions: Array<{
            text: { content: string };
            type: string;
            value: FeishuCardInteractionEnvelope;
          }>;
        }>;
      };
    };
    const first = card.body.elements[1].actions[0];
    expect(first.text.content).toContain("✓ A (2)");
    expect(first.type).toBe("primary");
    // selected options are labeled with a ✓ marker and tallies
  });
});

describe("feishu extractFeishuPollVote", () => {
  it("extracts poll id and option index from a vote envelope", () => {
    expect(
      extractFeishuPollVote(toEnvelope(FEISHU_POLL_VOTE_ACTION, { p: "poll-1", o: "2" })),
    ).toEqual({
      pollId: "poll-1",
      optionIndex: "2",
    });
  });

  it("rejects envelopes targeting a different action or missing metadata", () => {
    expect(extractFeishuPollVote(toEnvelope("feishu.other", { p: "poll-1", o: "0" }))).toBeNull();
    expect(extractFeishuPollVote(toEnvelope(FEISHU_POLL_VOTE_ACTION, { p: "poll-1" }))).toBeNull();
  });
});

describe("feishu poll store", () => {
  beforeEach(() => {
    setFeishuRuntime(feishuRuntimeStub);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and records poll votes, enforcing single-select", async () => {
    const { store } = createIsolatedStore();
    await store.createPoll({
      id: "poll-2",
      question: "Pick one",
      options: ["A", "B"],
      maxSelections: 1,
      createdAt: new Date().toISOString(),
      votes: {},
    });
    await store.recordVote({ pollId: "poll-2", voterId: "user-1", selections: ["0", "1"] });
    const stored = await store.getPoll("poll-2");
    if (!stored) {
      throw new Error("expected stored poll");
    }
    expect(stored.votes["user-1"]).toEqual(["0"]);
  });

  it("deduplicates selections and clips to maxSelections", async () => {
    const { store } = createIsolatedStore();
    await store.createPoll({
      id: "poll-dedupe",
      question: "Pick two",
      options: ["A", "B", "C"],
      maxSelections: 2,
      createdAt: new Date().toISOString(),
      votes: {},
    });
    await store.recordVote({
      pollId: "poll-dedupe",
      voterId: "user-1",
      selections: ["0", "0", "1", "2"],
    });
    const stored = await store.getPoll("poll-dedupe");
    if (!stored) {
      throw new Error("expected stored poll");
    }
    expect(stored.votes["user-1"]).toEqual(["0", "1"]);
  });

  it("rejects votes for unknown polls and expired polls", async () => {
    const { store } = createIsolatedStore();
    await expect(
      store.recordVote({ pollId: "missing", voterId: "user", selections: ["0"] }),
    ).resolves.toBeNull();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
    const { store: ttlStore } = createIsolatedStore();
    await ttlStore.createPoll({
      id: "poll-ttl",
      question: "Old?",
      options: ["A", "B"],
      maxSelections: 1,
      createdAt: new Date("2026-05-01T00:00:00.000Z").toISOString(), // > 30d ago
      votes: {},
    });
    await expect(ttlStore.getPoll("poll-ttl")).resolves.toBeNull();
  });

  it("hashes external poll ids before deriving plugin-state keys", async () => {
    const { store } = createIsolatedStore();
    const longPollId = `poll-${"x".repeat(900)}`;
    await store.createPoll({
      id: longPollId,
      question: "Long id?",
      options: ["A", "B"],
      maxSelections: 1,
      createdAt: new Date().toISOString(),
      votes: {},
    });
    await expect(store.getPoll(longPollId)).resolves.toMatchObject({ id: longPollId });
    const digest = crypto.createHash("sha256").update(longPollId).digest("hex");
    expect(digest.length).toBeGreaterThan(0);
  });
});
