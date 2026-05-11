import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createMSTeamsPollStoreMemory } from "./polls-store-memory.js";
import { buildMSTeamsPollCard, createMSTeamsPollStoreFs, extractMSTeamsPollVote } from "./polls.js";
import { setMSTeamsRuntime } from "./runtime.js";
import { msteamsRuntimeStub } from "./test-runtime.js";

describe("msteams polls", () => {
  beforeEach(() => {
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
    const store = createMSTeamsPollStoreFs({ homedir: () => home });
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

const createFsStore = async () => {
  const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-polls-"));
  return createMSTeamsPollStoreFs({ stateDir });
};

const createMemoryStore = () => createMSTeamsPollStoreMemory();

describe.each([
  { name: "memory", createStore: createMemoryStore },
  { name: "fs", createStore: createFsStore },
])("$name poll store", ({ createStore }) => {
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
