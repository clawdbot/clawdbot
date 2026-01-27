import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createMSTeamsPollStoreFs } from "./polls.js";
import { createMSTeamsPollStoreMemory } from "./polls-store-memory.js";

const createFsStore = async () => {
  const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "moltbot-msteams-polls-"));
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

    expect(poll?.votes["user-1"]).toEqual(["0"]);
  });
});
