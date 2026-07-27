import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { describe, expect, it } from "vitest";
import { createAccountScopedMSTeamsPollStore } from "./poll-store-scoped.js";
import type { MSTeamsPoll, MSTeamsPollStore } from "./polls.js";

function createMemoryPollStore(): MSTeamsPollStore {
  const polls = new Map<string, MSTeamsPoll>();
  return {
    createPoll: async (createdPoll) => {
      polls.set(createdPoll.id, structuredClone(createdPoll));
    },
    getPoll: async (pollId) => {
      const storedPoll = polls.get(pollId);
      return storedPoll ? structuredClone(storedPoll) : null;
    },
    recordVote: async ({ pollId, voterId, selections }) => {
      const storedPoll = polls.get(pollId);
      if (!storedPoll) {
        return null;
      }
      const updated = {
        ...storedPoll,
        votes: { ...storedPoll.votes, [voterId]: selections },
      };
      polls.set(pollId, updated);
      return structuredClone(updated);
    },
  };
}

function buildPoll(id: string, question: string): MSTeamsPoll {
  return {
    id,
    question,
    options: ["A", "B"],
    maxSelections: 1,
    createdAt: "2026-07-27T00:00:00.000Z",
    votes: {},
  };
}

describe("account-scoped MSTeams poll store", () => {
  it("preserves legacy unscoped polls for the default account", async () => {
    const store = createMemoryPollStore();
    await store.createPoll(buildPoll("legacy-poll", "Legacy"));

    const defaultStore = createAccountScopedMSTeamsPollStore(store, DEFAULT_ACCOUNT_ID);

    expect(defaultStore).toBe(store);
    await expect(defaultStore.getPoll("legacy-poll")).resolves.toMatchObject({
      id: "legacy-poll",
      question: "Legacy",
    });
  });

  it("isolates matching poll ids and votes between named accounts", async () => {
    const store = createMemoryPollStore();
    const supportStore = createAccountScopedMSTeamsPollStore(store, "support");
    const financeStore = createAccountScopedMSTeamsPollStore(store, "finance");

    await supportStore.createPoll(buildPoll("shared-poll", "Support"));
    await financeStore.createPoll(buildPoll("shared-poll", "Finance"));
    await supportStore.recordVote({
      pollId: "shared-poll",
      voterId: "user-1",
      selections: ["0"],
    });

    await expect(supportStore.getPoll("shared-poll")).resolves.toMatchObject({
      id: "shared-poll",
      question: "Support",
      votes: { "user-1": ["0"] },
    });
    await expect(financeStore.getPoll("shared-poll")).resolves.toMatchObject({
      id: "shared-poll",
      question: "Finance",
      votes: {},
    });
    await expect(store.getPoll("shared-poll")).resolves.toBeNull();
  });
});
