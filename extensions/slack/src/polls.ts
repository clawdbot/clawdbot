// Slack plugin module implements polls behavior using interactive block
// buttons rendered by the poll block builder and tallied by the poll store.
import crypto from "node:crypto";
import type { Block, KnownBlock } from "@slack/web-api";
import {
  parseStrictNonNegativeInteger,
  parseDateStringTimestampMs,
} from "openclaw/plugin-sdk/number-runtime";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveSlackSqliteStateEnv,
  toPluginJsonValue,
  withSlackSqliteMutationLock,
} from "./poll-state.js";
import { SLACK_POLL_VOTE_ACTION_ID } from "./reply-action-ids.js";
import { getSlackRuntime } from "./runtime.js";

const SLACK_POLLS_NAMESPACE = "slack.polls";
const SLACK_POLL_VOTE_BUCKETS_NAMESPACE = "slack.poll-vote-buckets";

const SLACK_MAX_POLLS = 1000;
const SLACK_SQLITE_MAX_POLL_ROWS = SLACK_MAX_POLLS + 1000;
// Keep worst-case retained vote buckets below plugin-state's per-plugin live row cap.
const SLACK_POLL_VOTE_BUCKET_COUNT = 16;
const SLACK_MAX_POLL_VOTE_BUCKET_ROWS = (SLACK_MAX_POLLS + 1) * SLACK_POLL_VOTE_BUCKET_COUNT;
const SLACK_POLL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SLACK_POLL_MUTATION_KEY = "slack-polls";
export const SLACK_POLL_MAX_OPTIONS = 20;

type SlackPoll = {
  id: string;
  question: string;
  options: string[];
  maxSelections: number;
  createdAt: string;
  updatedAt?: string;
  conversationId?: string;
  messageId?: string;
  votes: Record<string, string[]>;
};

export type SlackPollVote = {
  pollId: string;
  optionIndex: string;
  voterId?: string;
};

export type SlackPollStore = {
  createPoll: (poll: SlackPoll) => Promise<void>;
  getPoll: (pollId: string) => Promise<SlackPoll | null>;
  recordVote: (params: {
    pollId: string;
    voterId: string;
    selections: string[];
    /**
     * "replace" overwrites the voter's prior selections with the normalized
     * new set (single-select polls). "toggle" merges each supplied option into
     * the voter's existing set, adding when absent and removing when present,
     * so a multi-select poll can retain more than one choice across clicks.
     */
    mode?: "replace" | "toggle";
  }) => Promise<{ poll: SlackPoll; capped: boolean } | null>;
};

type StoredSlackPoll = Omit<SlackPoll, "votes">;

type StoredSlackPollVoteBucket = {
  pollId: string;
  bucket: string;
  votes: Record<string, string[]>;
  updatedAt: string;
};

function normalizeSlackPollOption(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

export function decodeSlackPollVoteAction(actionId: string, value?: unknown): SlackPollVote | null {
  if (!actionId.startsWith(`${SLACK_POLL_VOTE_ACTION_ID}:`)) {
    return null;
  }
  const pollId = actionId.slice(`${SLACK_POLL_VOTE_ACTION_ID}:`.length).trim();
  if (!pollId) {
    return null;
  }
  const optionIndex = normalizeSlackPollOption(value);
  return optionIndex ? { pollId, optionIndex } : null;
}

function buildSlackPollVoteActionId(pollId: string): string {
  return `${SLACK_POLL_VOTE_ACTION_ID}:${pollId}`;
}

function countSlackPollTallies(votes: Record<string, string[]>): number[] {
  const tally: number[] = [];
  for (const selections of Object.values(votes)) {
    for (const option of selections) {
      const index = parseStrictNonNegativeInteger(option);
      if (index === undefined) {
        continue;
      }
      tally[index] = (tally[index] ?? 0) + 1;
    }
  }
  return tally;
}

// Slack Block Kit field limits. A section text field accepts up to 3,000
// characters and a button plain_text label up to 75; exceeding either makes
// the entire poll message invalid, so the poll owner truncates before posting.
// https://api.slack.com/reference/block-kit/blocks#section
// https://api.slack.com/reference/block-kit/block-elements#button
const SLACK_POLL_SECTION_TEXT_LIMIT = 3_000;
const SLACK_POLL_BUTTON_LABEL_LIMIT = 75;

function truncateSlackPollText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  // Reserve one glyph for the ellipsis so the truncated form never exceeds the limit.
  return `${value.slice(0, limit - 1)}…`;
}

function buildSlackPollBlocks(params: {
  question: string;
  options: string[];
  maxSelections?: number;
  pollId: string;
  votes?: Record<string, string[]>;
}): (Block | KnownBlock)[] {
  const maxSelections =
    typeof params.maxSelections === "number" && params.maxSelections > 1
      ? Math.min(Math.floor(params.maxSelections), params.options.length)
      : 1;
  // Defense in depth: core already caps options at pollMaxOptions before
  // sendPoll runs, but this renderer is exported and must never emit a Slack
  // actions block with more than SLACK_POLL_MAX_OPTIONS buttons.
  const cappedOptions = params.options.slice(0, SLACK_POLL_MAX_OPTIONS);
  const tally = countSlackPollTallies(params.votes ?? {});
  // Shared poll blocks are voter-neutral: chat.update replaces the common
  // message, so a per-voter checkmark would show every viewer the last voter's
  // private selection. Voters get confirmation through the ephemeral reply
  // in the block-action handler instead.
  const blocks: (Block | KnownBlock)[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncateSlackPollText(params.question, SLACK_POLL_SECTION_TEXT_LIMIT),
      },
    },
    {
      type: "actions",
      elements: cappedOptions.map((option, index) => {
        const tallyCount = tally[index] ?? 0;
        const label = `${option}${tallyCount > 0 ? ` (${tallyCount})` : ""}`;
        return {
          type: "button",
          text: {
            type: "plain_text",
            text: truncateSlackPollText(label, SLACK_POLL_BUTTON_LABEL_LIMIT),
          },
          value: String(index),
          action_id: buildSlackPollVoteActionId(params.pollId),
        } as const;
      }),
    },
  ];
  const totalVoter = Object.keys(params.votes ?? {}).length;
  const hint =
    maxSelections > 1
      ? `Select up to ${maxSelections} options. ${totalVoter} voted.`
      : `${totalVoter} voted. Tap an option to vote.`;
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: hint }] });
  return blocks;
}

export function buildSlackPollMessage(params: {
  question: string;
  options: string[];
  maxSelections?: number;
  pollId?: string;
  votes?: Record<string, string[]>;
}): { pollId: string; text: string; blocks: (Block | KnownBlock)[] } {
  const pollId = params.pollId ?? crypto.randomUUID();
  const blocks = buildSlackPollBlocks({
    question: params.question,
    options: params.options,
    maxSelections: params.maxSelections,
    pollId,
    votes: params.votes,
  });
  return { pollId, text: `Poll: ${params.question}`, blocks };
}

function createSlackPollStateStore(options?: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
}) {
  return getSlackRuntime().state.openKeyedStore<StoredSlackPoll>({
    namespace: SLACK_POLLS_NAMESPACE,
    maxEntries: SLACK_SQLITE_MAX_POLL_ROWS,
    env: resolveSlackSqliteStateEnv(options),
  });
}

function createSlackPollVoteBucketStateStore(options?: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
}) {
  return getSlackRuntime().state.openKeyedStore<StoredSlackPollVoteBucket>({
    namespace: SLACK_POLL_VOTE_BUCKETS_NAMESPACE,
    maxEntries: SLACK_MAX_POLL_VOTE_BUCKET_ROWS,
    env: resolveSlackSqliteStateEnv(options),
  });
}

function parseSlackPollTimestamp(value?: string): number | null {
  return parseDateStringTimestampMs(value) ?? null;
}

function pruneExpiredSlackPolls<T extends { createdAt: string; updatedAt?: string }>(
  polls: Record<string, T>,
): Record<string, T> {
  const cutoff = Date.now() - SLACK_POLL_TTL_MS;
  const entries = Object.entries(polls).filter(([, poll]) => {
    const ts = parseSlackPollTimestamp(poll.updatedAt ?? poll.createdAt) ?? 0;
    return ts >= cutoff;
  });
  return Object.fromEntries(entries);
}

function normalizeSlackPollSelections(poll: SlackPoll, selections: string[]) {
  const maxSelections = Math.max(1, poll.maxSelections);
  const mapped = selections
    .map((entry) => parseStrictNonNegativeInteger(entry))
    .filter((value): value is number => value !== undefined)
    .filter((value) => value >= 0 && value < poll.options.length)
    .map((value) => String(value));
  return uniqueStrings(mapped).slice(0, maxSelections);
}

/**
 * Toggle each supplied option into the voter's existing selection set: present
 * options are removed, absent ones added. Returns the merged set bounded by
 * maxSelections plus a flag indicating whether the bound was hit (in which case
 * the new option was refused and the prior set is preserved unchanged).
 */
function toggleSlackPollSelections(
  poll: SlackPoll,
  existing: string[],
  toggled: string[],
): { selections: string[]; capped: boolean } {
  const maxSelections = Math.max(1, poll.maxSelections);
  const normalizedExisting = normalizeSlackPollSelections(poll, existing);
  const normalizedToggled = normalizeSlackPollSelections(poll, toggled);
  const existingSet = new Set(normalizedExisting);
  let capped = false;
  for (const option of normalizedToggled) {
    if (existingSet.has(option)) {
      existingSet.delete(option);
      continue;
    }
    if (existingSet.size >= maxSelections) {
      capped = true;
      continue;
    }
    existingSet.add(option);
  }
  return { selections: [...existingSet], capped };
}

function splitSlackPoll(poll: SlackPoll): {
  metadata: StoredSlackPoll;
  votes: SlackPoll["votes"];
} {
  const { votes, ...metadata } = poll;
  return { metadata, votes };
}

function hashSlackPollVote(pollId: string, voterId: string): string {
  return crypto.createHash("sha256").update(pollId).update("\0").update(voterId).digest("hex");
}

function buildSlackPollStateKey(pollId: string): string {
  return crypto.createHash("sha256").update(pollId).digest("hex");
}

function selectSlackPollVoteBucket(pollId: string, voterId: string): string {
  const bucket = Number.parseInt(hashSlackPollVote(pollId, voterId).slice(0, 8), 16);
  return String(bucket % SLACK_POLL_VOTE_BUCKET_COUNT).padStart(4, "0");
}

function buildSlackPollVoteBucketKey(pollId: string, bucket: string): string {
  const pollDigest = crypto.createHash("sha256").update(pollId).digest("hex");
  return `${pollDigest}:${bucket}`;
}

export function createSlackPollStoreState(options?: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
}): SlackPollStore {
  const pollStore = createSlackPollStateStore(options);
  const voteBucketStore = createSlackPollVoteBucketStateStore(options);

  const readPollVotes = async (pollId: string): Promise<Record<string, string[]>> => {
    const votes: Record<string, string[]> = {};
    for (const row of await voteBucketStore.entries()) {
      if (row.value.pollId === pollId) {
        Object.assign(votes, row.value.votes);
      }
    }
    return votes;
  };

  const deletePollVotes = async (pollId: string): Promise<void> => {
    for (const row of await voteBucketStore.entries()) {
      if (row.value.pollId === pollId) {
        await voteBucketStore.delete(row.key);
      }
    }
  };

  const registerPollVote = async (
    pollId: string,
    voterId: string,
    selections: string[],
    updatedAt: string,
  ): Promise<void> => {
    const bucket = selectSlackPollVoteBucket(pollId, voterId);
    const key = buildSlackPollVoteBucketKey(pollId, bucket);
    const existing = await voteBucketStore.lookup(key);
    await voteBucketStore.register(
      key,
      toPluginJsonValue({
        pollId,
        bucket,
        votes: { ...existing?.votes, [voterId]: selections },
        updatedAt,
      }),
    );
  };

  const reconstructPoll = async (metadata: StoredSlackPoll): Promise<SlackPoll> => {
    return { ...metadata, votes: await readPollVotes(metadata.id) };
  };

  const prunePollStoreToLimit = async (): Promise<void> => {
    const rows: Array<{ key: string; value: StoredSlackPoll }> = [];
    for (const row of await pollStore.entries()) {
      if (!pruneExpiredSlackPolls({ [row.key]: row.value })[row.key]) {
        await pollStore.delete(row.key);
        await deletePollVotes(row.value.id);
        continue;
      }
      rows.push(row);
    }
    if (rows.length <= SLACK_MAX_POLLS) {
      return;
    }
    const sorted = rows.toSorted((a, b) => {
      const aTs = parseSlackPollTimestamp(a.value.updatedAt ?? a.value.createdAt) ?? 0;
      const bTs = parseSlackPollTimestamp(b.value.updatedAt ?? b.value.createdAt) ?? 0;
      return aTs - bTs || a.key.localeCompare(b.key);
    });
    for (const row of sorted.slice(0, rows.length - SLACK_MAX_POLLS)) {
      await pollStore.delete(row.key);
      await deletePollVotes(row.value.id);
    }
  };

  const createPoll = async (poll: SlackPoll) => {
    await withSlackSqliteMutationLock(options, SLACK_POLL_MUTATION_KEY, async () => {
      const { metadata, votes } = splitSlackPoll(poll);
      await pollStore.register(buildSlackPollStateKey(poll.id), toPluginJsonValue(metadata));
      await deletePollVotes(poll.id);
      for (const [voterId, selections] of Object.entries(votes)) {
        await registerPollVote(poll.id, voterId, selections, poll.updatedAt ?? poll.createdAt);
      }
      await prunePollStoreToLimit();
    });
  };

  const getPoll = async (pollId: string) => {
    const poll = await pollStore.lookup(buildSlackPollStateKey(pollId));
    if (!poll) {
      return null;
    }
    if (!pruneExpiredSlackPolls({ [pollId]: poll })[pollId]) {
      return null;
    }
    return await reconstructPoll(poll);
  };

  const recordVote = async (vote: {
    pollId: string;
    voterId: string;
    selections: string[];
    mode?: "replace" | "toggle";
  }) => {
    return await withSlackSqliteMutationLock(options, SLACK_POLL_MUTATION_KEY, async () => {
      const pollKey = buildSlackPollStateKey(vote.pollId);
      const poll = await pollStore.lookup(pollKey);
      if (!poll) {
        return null;
      }
      if (!pruneExpiredSlackPolls({ [vote.pollId]: poll })[vote.pollId]) {
        await pollStore.delete(pollKey);
        await deletePollVotes(vote.pollId);
        return null;
      }
      const currentPoll = await reconstructPoll(poll);
      const priorSelections = currentPoll.votes[vote.voterId] ?? [];
      const resolved =
        vote.mode === "toggle"
          ? toggleSlackPollSelections(currentPoll, priorSelections, vote.selections)
          : {
              selections: normalizeSlackPollSelections(currentPoll, vote.selections),
              capped: false,
            };
      const updatedAt = new Date().toISOString();
      poll.updatedAt = updatedAt;
      await pollStore.register(pollKey, toPluginJsonValue(poll));
      await registerPollVote(vote.pollId, vote.voterId, resolved.selections, updatedAt);
      await prunePollStoreToLimit();
      return { poll: await reconstructPoll(poll), capped: resolved.capped };
    });
  };

  return { createPoll, getPoll, recordVote };
}
