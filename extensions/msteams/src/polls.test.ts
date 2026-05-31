import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { createMSTeamsPollStoreMemory } from "./polls-store-memory.js";
import {
  buildMSTeamsPollCard,
  createMSTeamsPollStoreState,
  extractMSTeamsPollVote,
  normalizeMSTeamsPollSelections,
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

  it("does not coerce partial poll selections", () => {
    expect(
      normalizeMSTeamsPollSelections(
        {
          id: "poll-1",
          question: "Lunch?",
          options: ["Pizza", "Sushi"],
          maxSelections: 2,
          votes: {},
          createdAt: "2026-03-22T00:00:00.000Z",
        },
        ["0", "1x"],
      ),
    ).toEqual(["0"]);
  });

  it("accepts only strict decimal poll selections", () => {
    expect(
      normalizeMSTeamsPollSelections(
        {
          id: "poll-1",
          question: "Lunch?",
          options: ["Pizza", "Sushi"],
          maxSelections: 2,
          votes: {},
          createdAt: "2026-03-22T00:00:00.000Z",
        },
        ["+0", "0x1", "1"],
      ),
    ).toEqual(["0", "1"]);
  });
});

const createStateStore = async () => {
  const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-polls-"));
  return createMSTeamsPollStoreState({ stateDir });
};

const createMemoryStore = () => createMSTeamsPollStoreMemory();

describe.each([
  { name: "memory", createStore: createMemoryStore },
  { name: "state", createStore: createStateStore },
])("$name poll store", ({ createStore }) => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    setMSTeamsRuntime(msteamsRuntimeStub);
  });

  it("stores polls and records normalized votes", async () => {
    const store = await createStore();
    await store.createPoll({
      id: "poll-1",
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
      createdAt: new Date().toISOString(),
      votes: {},
    });

    const poll = await store.recordVote({
      pollId: "poll-1",
      voterId: "user-1",
      selections: ["0", "1"],
    });

    if (!poll) {
      throw new Error("poll store did not return the updated poll");
    }
    expect(poll.votes["user-1"]).toEqual(["0"]);
  });
});

describe("state poll store", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    setMSTeamsRuntime(msteamsRuntimeStub);
  });

  it("imports legacy JSON polls once and removes the old file", async () => {
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
    await expect(store.getPoll("poll-legacy")).resolves.toMatchObject({
      id: "poll-legacy",
      question: "Legacy?",
    });
    await expect(fs.promises.access(filePath)).rejects.toThrow();

    const updated = await store.recordVote({
      pollId: "poll-legacy",
      voterId: "user-1",
      selections: ["1"],
    });
    expect(updated?.votes["user-1"]).toEqual(["1"]);
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

  it("fills missing legacy vote buckets after a partial metadata import", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-polls-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const filePath = path.join(stateDir, "msteams-polls.json");
    const metadata = {
      id: "poll-partial",
      question: "Partial?",
      options: ["A", "B"],
      maxSelections: 1,
      createdAt: new Date().toISOString(),
    };
    const metadataStore = createPluginStateKeyedStoreForTests<typeof metadata>("msteams", {
      namespace: "polls",
      maxEntries: 2000,
      env,
    });
    await metadataStore.register("poll-partial", metadata);
    const voterHash = crypto
      .createHash("sha256")
      .update("poll-partial")
      .update("\0")
      .update("user-legacy")
      .digest("hex");
    const bucket = String(Number.parseInt(voterHash.slice(0, 8), 16) % 32).padStart(4, "0");
    const pollHash = crypto.createHash("sha256").update("poll-partial").digest("hex");
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
    await voteBucketStore.register(`${pollHash}:${bucket}`, {
      pollId: "poll-partial",
      bucket,
      votes: { "user-legacy": ["0"] },
      updatedAt: metadata.createdAt,
    });
    await fs.promises.writeFile(
      filePath,
      `${JSON.stringify({
        version: 1,
        polls: {
          "poll-partial": {
            ...metadata,
            votes: {
              "user-legacy": ["1"],
              "user-missing": ["1"],
            },
          },
        },
      })}\n`,
    );

    const store = createMSTeamsPollStoreState({ env });

    await expect(store.getPoll("poll-partial")).resolves.toMatchObject({
      votes: {
        "user-legacy": ["0"],
        "user-missing": ["1"],
      },
    });
  });

  it("keeps newest legacy polls by update timestamp at the row cap", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-polls-"));
    const filePath = path.join(stateDir, "msteams-polls.json");
    const pollRows: Record<string, MSTeamsPoll> = {};
    const baseMs = Date.now() - 60_000;
    pollRows["poll-recent"] = {
      id: "poll-recent",
      question: "Recent?",
      options: ["A", "B"],
      maxSelections: 1,
      createdAt: new Date(baseMs + 2_000_000).toISOString(),
      updatedAt: new Date(baseMs + 2_000_000).toISOString(),
      votes: {},
    };
    for (let index = 0; index < 1000; index += 1) {
      const id = `poll-${String(index).padStart(4, "0")}`;
      pollRows[id] = {
        id,
        question: "Old?",
        options: ["A", "B"],
        maxSelections: 1,
        createdAt: new Date(baseMs + index).toISOString(),
        votes: {},
      };
    }
    await fs.promises.writeFile(filePath, `${JSON.stringify({ version: 1, polls: pollRows })}\n`);

    const store = createMSTeamsPollStoreState({ stateDir });

    await expect(store.getPoll("poll-recent")).resolves.toMatchObject({ id: "poll-recent" });
    await expect(store.getPoll("poll-0000")).resolves.toBeNull();
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

describe("memory poll store", () => {
  it("reads seeded polls back, updates timestamps, and returns null for missing polls", async () => {
    const store = createMSTeamsPollStoreMemory([
      {
        id: "poll-1",
        question: "Pick one",
        options: ["A", "B"],
        maxSelections: 1,
        votes: {},
        createdAt: "2026-03-22T00:00:00.000Z",
        updatedAt: "2026-03-22T00:00:00.000Z",
      },
    ]);

    await expect(store.getPoll("poll-1")).resolves.toEqual({
      id: "poll-1",
      question: "Pick one",
      options: ["A", "B"],
      maxSelections: 1,
      votes: {},
      createdAt: "2026-03-22T00:00:00.000Z",
      updatedAt: "2026-03-22T00:00:00.000Z",
    });

    const originalUpdatedAt = "2026-03-22T00:00:00.000Z";
    const result = await store.recordVote({
      pollId: "poll-1",
      voterId: "user-1",
      selections: ["1", "0", "missing"],
    });

    expect(result?.votes["user-1"]).toEqual(["1"]);
    expect(result?.updatedAt).not.toBe(originalUpdatedAt);

    await store.createPoll({
      id: "poll-2",
      question: "Pick many",
      options: ["X", "Y"],
      maxSelections: 2,
      votes: {},
      createdAt: "2026-03-22T00:00:00.000Z",
      updatedAt: "2026-03-22T00:00:00.000Z",
    });

    const updatedPoll = await store.recordVote({
      pollId: "poll-2",
      voterId: "user-2",
      selections: ["1", "0", "1"],
    });
    if (!updatedPoll?.updatedAt) {
      throw new Error("expected updated poll timestamp after recordVote");
    }
    const { updatedAt, ...stableUpdatedPoll } = updatedPoll;
    expect(typeof updatedAt).toBe("string");
    expect(stableUpdatedPoll).toEqual({
      id: "poll-2",
      question: "Pick many",
      options: ["X", "Y"],
      maxSelections: 2,
      votes: {
        "user-2": ["1", "0"],
      },
      createdAt: "2026-03-22T00:00:00.000Z",
    });

    await expect(
      store.recordVote({ pollId: "missing", voterId: "nobody", selections: ["x"] }),
    ).resolves.toBeNull();
  });
});
