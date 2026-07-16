import {
  type MSTeamsPoll,
  type MSTeamsPollStore,
  normalizeMSTeamsPollSelections,
} from "./polls.js";

export function createMSTeamsPollStoreMemory(initial: MSTeamsPoll[] = []): MSTeamsPollStore {
  const polls = new Map<string, MSTeamsPoll>();
  for (const poll of initial) {
    polls.set(poll.id, { ...poll });
  }

  const createPoll = async (poll: MSTeamsPoll) => {
    polls.set(poll.id, { ...poll });
  };

  const getPoll = async (pollId: string) => polls.get(pollId) ?? null;

  const recordVote = async (params: { pollId: string; voterId: string; selections: string[] }) => {
    const poll = polls.get(params.pollId);
    if (!poll) {
      return null;
    }
    const normalized = normalizeMSTeamsPollSelections(poll, params.selections);
    poll.votes[params.voterId] = normalized;
    poll.updatedAt = new Date().toISOString();
    polls.set(poll.id, poll);
    return poll;
  };

  return { createPoll, getPoll, recordVote };
}
