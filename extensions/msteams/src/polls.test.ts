// Msteams tests cover polls plugin behavior.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildMSTeamsPollCard,
  createMSTeamsPollStoreState,
  extractMSTeamsPollVote,
  type MSTeamsPoll,
} from "./polls.js";
import { setMSTeamsRuntime } from "./runtime.js";
import { msteamsRuntimeStub } from "./test-support/runtime.js";

describe("msteams polls", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    setMSTeamsRuntime(msteamsRuntimeStub);
  });

  it("builds poll cards with fallback text", () => {
    const card = buildMSTeamsPollCard({
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
    });

    expect(card.pollId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(card.fallbackText).toBe("Poll: Lunch?\n1. Pizza\n2. Sushi");
  });

  it("extracts poll votes from activity values", () => {
    const vote = extractMSTeamsPollVote({
      value: {
        openclawPollId: "poll-1",
        choices: "0,1",
      },
    });

    expect(vote).toEqual({
      pollId: "poll-1",
      selections: ["0", "1"],
    });
  });

  it("stores and records poll votes", async () => {
    const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-polls-"));
    const store = createMSTeamsPollStoreState({ homedir: () => home });
    await store.createPoll({
      id: "poll-2",
      question: "Pick one",
      options: ["A", "B"],
      maxSelections: 1,
      createdAt: new Date().toISOString(),
      votes: {},
    });
    await store.recordVote({
      pollId: "poll-2",
      voterId: "user-1",
      selections: ["0", "1"],
    });
    const stored = await store.getPoll("poll-2");
    if (!stored) {
      throw new Error("expected stored poll after recordVote");
    }
    expect(stored.votes["user-1"]).toEqual(["0"]);
  });
});

describe("state poll store", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    setMSTeamsRuntime(msteamsRuntimeStub);
  });

  it("ignores legacy JSON polls at runtime", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-polls-"));
    const filePath = path.join(stateDir, "msteams-polls.json");
    await fs.promises.writeFile(
      filePath,
      `${JSON.stringify({
        version: 1,
        polls: {
          "poll-legacy": {
            id: "poll-legacy",
            question: "Legacy?",
            options: ["A", "B"],
            maxSelections: 1,
            createdAt: new Date().toISOString(),
            votes: {},
          },
        },
      })}\n`,
    );

    const store = createMSTeamsPollStoreState({ stateDir });
    await expect(store.getPoll("poll-legacy")).resolves.toBeNull();
    await expect(fs.promises.access(filePath)).resolves.toBeUndefined();

    await store.createPoll({
      id: "poll-new",
      question: "New?",
      options: ["A", "B"],
      maxSelections: 1,
      createdAt: new Date().toISOString(),
      votes: {},
    });
    await expect(store.getPoll("poll-new")).resolves.toMatchObject({ id: "poll-new" });
    await expect(
      fs.promises.access(path.join(stateDir, "state", "openclaw.sqlite")),
    ).resolves.toBeUndefined();
  });

  it("hashes external poll ids before using plugin-state keys", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-polls-"));
    const store = createMSTeamsPollStoreState({ stateDir });
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
    await expect(
      store.recordVote({
        pollId: `missing-${"y".repeat(900)}`,
        voterId: "user-1",
        selections: ["0"],
      }),
    ).resolves.toBeNull();
  });

  it("serializes concurrent votes for the same poll", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-polls-"));
    const store = createMSTeamsPollStoreState({ stateDir });
    await store.createPoll({
      id: "poll-race",
      question: "Pick",
      options: ["A", "B"],
      maxSelections: 1,
      createdAt: new Date().toISOString(),
      votes: {},
    });

    await Promise.all([
      store.recordVote({ pollId: "poll-race", voterId: "user-a", selections: ["0"] }),
      store.recordVote({ pollId: "poll-race", voterId: "user-b", selections: ["1"] }),
    ]);

    await expect(store.getPoll("poll-race")).resolves.toMatchObject({
      votes: {
        "user-a": ["0"],
        "user-b": ["1"],
      },
    });
  });

  it.each([
    { selections: ["0", "1x"], expected: ["0"] },
    { selections: ["+0", "0x1", "1"], expected: ["0", "1"] },
  ])("accepts only strict decimal poll selections", async ({ selections, expected }) => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-polls-"));
    const store = createMSTeamsPollStoreState({ stateDir });
    await store.createPoll({
      id: "poll-strict-selections",
      question: "Pick",
      options: ["A", "B"],
      maxSelections: 2,
      createdAt: new Date().toISOString(),
      votes: {},
    });

    await expect(
      store.recordVote({
        pollId: "poll-strict-selections",
        voterId: "user-1",
        selections,
      }),
    ).resolves.toMatchObject({ votes: { "user-1": expected } });
  });

  it("keeps large vote maps split across bounded rows", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-polls-"));
    const store = createMSTeamsPollStoreState({ stateDir });
    const votes = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [
        `user-${String(index).padStart(4, "0")}-${"x".repeat(160)}`,
        ["0"],
      ]),
    );

    await store.createPoll({
      id: "poll-large",
      question: "Pick",
      options: ["A", "B"],
      maxSelections: 1,
      createdAt: new Date().toISOString(),
      votes,
    });
    await store.recordVote({ pollId: "poll-large", voterId: "user-new", selections: ["1"] });

    const stored = await store.getPoll("poll-large");
    expect(Object.keys(stored?.votes ?? {})).toHaveLength(501);
    expect(stored?.votes["user-new"]).toEqual(["1"]);
  });

  it("deletes vote buckets when pruning over the poll cap", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-polls-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const metadataStore = createPluginStateKeyedStoreForTests<Omit<MSTeamsPoll, "votes">>(
      "msteams",
      {
        namespace: "polls",
        maxEntries: 2000,
        env,
      },
    );
    const voteBucketStore = createPluginStateKeyedStoreForTests<{
      pollId: string;
      bucket: string;
      votes: Record<string, string[]>;
      updatedAt: string;
    }>("msteams", {
      namespace: "poll-vote-buckets",
      maxEntries: 32_032,
      env,
    });
    const pollStateKey = (pollId: string) =>
      crypto.createHash("sha256").update(pollId).digest("hex");
    const voteBucket = (pollId: string, voterId: string) => {
      const hash = crypto
        .createHash("sha256")
        .update(pollId)
        .update("\0")
        .update(voterId)
        .digest("hex");
      return String(Number.parseInt(hash.slice(0, 8), 16) % 32).padStart(4, "0");
    };
    const baseMs = Date.now() - 60_000;
    const oldPollId = "poll-old";

    for (const [index, id] of [
      oldPollId,
      ...Array.from({ length: 999 }, (_, entryIndex) => `poll-existing-${entryIndex}`),
    ].entries()) {
      await metadataStore.register(pollStateKey(id), {
        id,
        question: "Pick",
        options: ["A", "B"],
        maxSelections: 1,
        createdAt: new Date(baseMs + index).toISOString(),
      });
    }
    const oldBucket = voteBucket(oldPollId, "user-old");
    await voteBucketStore.register(`${pollStateKey(oldPollId)}:${oldBucket}`, {
      pollId: oldPollId,
      bucket: oldBucket,
      votes: { "user-old": ["0"] },
      updatedAt: new Date(baseMs).toISOString(),
    });

    const store = createMSTeamsPollStoreState({ env });
    await store.createPoll({
      id: "poll-new",
      question: "New?",
      options: ["A", "B"],
      maxSelections: 1,
      createdAt: new Date(baseMs + 2_000_000).toISOString(),
      votes: { "user-new": ["1"] },
    });

    await expect(store.getPoll(oldPollId)).resolves.toBeNull();
    const buckets = await voteBucketStore.entries();
    expect(buckets.some((row) => row.value.pollId === oldPollId)).toBe(false);
    expect(buckets.some((row) => row.value.pollId === "poll-new")).toBe(true);
  });
});
