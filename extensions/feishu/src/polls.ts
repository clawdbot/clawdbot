// Feishu plugin module implements polls behavior using interactive Card Kit
// buttons rendered by the poll card builder and tallied by the poll store.
import crypto from "node:crypto";
import {
  parseStrictNonNegativeInteger,
  parseDateStringTimestampMs,
} from "openclaw/plugin-sdk/number-runtime";
import { isRecord, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { FeishuCardInteractionEnvelope } from "./card-interaction.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import { buildFeishuCardButton } from "./card-ux-shared.js";
import {
  resolveFeishuSqliteStateEnv,
  toPluginJsonValue,
  withFeishuSqliteMutationLock,
} from "./poll-state.js";
import { getFeishuRuntime } from "./runtime.js";

export const FEISHU_POLL_VOTE_ACTION = "feishu.poll.vote";
export const FEISHU_POLLS_NAMESPACE = "feishu.polls";
export const FEISHU_POLL_VOTE_BUCKETS_NAMESPACE = "feishu.poll-vote-buckets";

const FEISHU_MAX_POLLS = 1000;
const FEISHU_SQLITE_MAX_POLL_ROWS = FEISHU_MAX_POLLS + 1000;
// Keep worst-case retained vote buckets below plugin-state's per-plugin live row cap.
const FEISHU_POLL_VOTE_BUCKET_COUNT = 16;
export const FEISHU_MAX_POLL_VOTE_BUCKET_ROWS =
  (FEISHU_MAX_POLLS + 1) * FEISHU_POLL_VOTE_BUCKET_COUNT;
const FEISHU_POLL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FEISHU_POLL_MUTATION_KEY = "feishu-polls";
export const FEISHU_POLL_MAX_OPTIONS = 20;

export type FeishuPoll = {
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

export type FeishuPollVote = {
  pollId: string;
  optionIndex: string;
};

export type FeishuPollStore = {
  createPoll: (poll: FeishuPoll) => Promise<void>;
  getPoll: (pollId: string) => Promise<FeishuPoll | null>;
  recordVote: (params: {
    pollId: string;
    voterId: string;
    selections: string[];
  }) => Promise<FeishuPoll | null>;
};

export type StoredFeishuPoll = Omit<FeishuPoll, "votes">;

export type StoredFeishuPollVoteBucket = {
  pollId: string;
  bucket: string;
  votes: Record<string, string[]>;
  updatedAt: string;
};

function readNestedString(value: unknown, keys: Array<string | number>): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }
    // SAFETY: isRecord narrowed `current` to a record, so a string/number index
    current = current[key as keyof typeof current];
  }
  return typeof current === "string" ? current : undefined;
}

export function extractFeishuPollVote(
  envelope: FeishuCardInteractionEnvelope,
): FeishuPollVote | null {
  if (envelope.a !== FEISHU_POLL_VOTE_ACTION) {
    return null;
  }
  const pollId = readNestedString(envelope.m, ["p"]);
  const optionIndex = readNestedString(envelope.m, ["o"]);
  if (!pollId || optionIndex === undefined) {
    return null;
  }
  return { pollId, optionIndex };
}

function countFeishuPollTallies(votes: Record<string, string[]>): number[] {
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

export function buildFeishuPollCard(params: {
  pollId: string;
  question: string;
  options: string[];
  maxSelections?: number;
  chatId?: string;
  chatType?: "p2p" | "group";
  votes?: Record<string, string[]>;
  voterOpenId?: string;
}): Record<string, unknown> {
  const maxSelections =
    typeof params.maxSelections === "number" && params.maxSelections > 1
      ? Math.min(Math.floor(params.maxSelections), params.options.length)
      : 1;
  const tally = countFeishuPollTallies(params.votes ?? {});
  const voterSelections = params.votes?.[params.voterOpenId ?? ""] ?? [];
  const context: FeishuCardInteractionEnvelope["c"] = {
    ...(params.chatId ? { h: params.chatId } : {}),
    ...(params.chatType ? { t: params.chatType } : {}),
  };

  const optionLines = params.options.map((option, index) => {
    const tallyCount = tally[index] ?? 0;
    const isSelected = voterSelections.includes(String(index));
    const marker = isSelected ? "✓ " : "";
    const label = `${marker}${option}${tallyCount > 0 ? ` (${tallyCount})` : ""}`;
    return {
      tag: "action",
      actions: [
        buildFeishuCardButton({
          label,
          type: isSelected ? "primary" : "default",
          value: createFeishuCardInteractionEnvelope({
            k: "button",
            a: FEISHU_POLL_VOTE_ACTION,
            m: { p: params.pollId, o: String(index) },
            c: context,
          }),
        }),
      ],
    };
  });

  const totalVoter = Object.keys(params.votes ?? {}).length;
  const hint =
    maxSelections > 1
      ? `Select up to ${maxSelections} option${maxSelections === 1 ? "" : "s"}. ${totalVoter} voted.`
      : `${totalVoter} voted. Tap an option to vote.`;

  return {
    schema: "2.0",
    config: {
      width_mode: "fill",
    },
    header: {
      title: {
        tag: "plain_text",
        content: "Poll",
      },
      template: "blue",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: params.question,
        },
        ...optionLines,
        {
          tag: "markdown",
          content: hint,
        },
      ],
    },
  };
}

function createFeishuPollStateStore(options?: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
}) {
  return getFeishuRuntime().state.openKeyedStore<StoredFeishuPoll>({
    namespace: FEISHU_POLLS_NAMESPACE,
    maxEntries: FEISHU_SQLITE_MAX_POLL_ROWS,
    env: resolveFeishuSqliteStateEnv(options),
  });
}

function createFeishuPollVoteBucketStateStore(options?: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
}) {
  return getFeishuRuntime().state.openKeyedStore<StoredFeishuPollVoteBucket>({
    namespace: FEISHU_POLL_VOTE_BUCKETS_NAMESPACE,
    maxEntries: FEISHU_MAX_POLL_VOTE_BUCKET_ROWS,
    env: resolveFeishuSqliteStateEnv(options),
  });
}

function parseFeishuTimestamp(value?: string): number | null {
  return parseDateStringTimestampMs(value) ?? null;
}

function pruneExpiredFeishuPolls<T extends { createdAt: string; updatedAt?: string }>(
  polls: Record<string, T>,
) {
  const cutoff = Date.now() - FEISHU_POLL_TTL_MS;
  const entries = Object.entries(polls).filter(([, poll]) => {
    const ts = parseFeishuTimestamp(poll.updatedAt ?? poll.createdAt) ?? 0;
    return ts >= cutoff;
  });
  return Object.fromEntries(entries);
}

function normalizeFeishuPollSelections(poll: FeishuPoll, selections: string[]) {
  const maxSelections = Math.max(1, poll.maxSelections);
  const mapped = selections
    .map((entry) => parseStrictNonNegativeInteger(entry))
    .filter((value): value is number => value !== undefined)
    .filter((value) => value >= 0 && value < poll.options.length)
    .map((value) => String(value));
  return uniqueStrings(mapped).slice(0, maxSelections);
}

export function splitFeishuPoll(poll: FeishuPoll): {
  metadata: StoredFeishuPoll;
  votes: FeishuPoll["votes"];
} {
  const { votes, ...metadata } = poll;
  return { metadata, votes };
}

function hashFeishuPollVote(pollId: string, voterId: string): string {
  return crypto.createHash("sha256").update(pollId).update("\0").update(voterId).digest("hex");
}

export function buildFeishuPollStateKey(pollId: string): string {
  return crypto.createHash("sha256").update(pollId).digest("hex");
}

export function selectFeishuPollVoteBucket(pollId: string, voterId: string): string {
  const bucket = Number.parseInt(hashFeishuPollVote(pollId, voterId).slice(0, 8), 16);
  return String(bucket % FEISHU_POLL_VOTE_BUCKET_COUNT).padStart(4, "0");
}

export function buildFeishuPollVoteBucketKey(pollId: string, bucket: string): string {
  const pollDigest = crypto.createHash("sha256").update(pollId).digest("hex");
  return `${pollDigest}:${bucket}`;
}

export function createFeishuPollStoreState(options?: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
}): FeishuPollStore {
  const pollStore = createFeishuPollStateStore(options);
  const voteBucketStore = createFeishuPollVoteBucketStateStore(options);

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
    const bucket = selectFeishuPollVoteBucket(pollId, voterId);
    const key = buildFeishuPollVoteBucketKey(pollId, bucket);
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

  const reconstructPoll = async (metadata: StoredFeishuPoll): Promise<FeishuPoll> => {
    return { ...metadata, votes: await readPollVotes(metadata.id) };
  };

  const prunePollStoreToLimit = async (): Promise<void> => {
    const rows = [];
    for (const row of await pollStore.entries()) {
      if (!pruneExpiredFeishuPolls({ [row.key]: row.value })[row.key]) {
        await pollStore.delete(row.key);
        await deletePollVotes(row.value.id);
        continue;
      }
      rows.push(row);
    }
    if (rows.length <= FEISHU_MAX_POLLS) {
      return;
    }
    const sorted = rows.toSorted((a, b) => {
      const aTs = parseFeishuTimestamp(a.value.updatedAt ?? a.value.createdAt) ?? 0;
      const bTs = parseFeishuTimestamp(b.value.updatedAt ?? b.value.createdAt) ?? 0;
      return aTs - bTs || a.key.localeCompare(b.key);
    });
    for (const row of sorted.slice(0, rows.length - FEISHU_MAX_POLLS)) {
      await pollStore.delete(row.key);
      await deletePollVotes(row.value.id);
    }
  };

  const createPoll = async (poll: FeishuPoll) => {
    await withFeishuSqliteMutationLock(options, FEISHU_POLL_MUTATION_KEY, async () => {
      const { metadata, votes } = splitFeishuPoll(poll);
      await pollStore.register(buildFeishuPollStateKey(poll.id), toPluginJsonValue(metadata));
      await deletePollVotes(poll.id);
      for (const [voterId, selections] of Object.entries(votes)) {
        await registerPollVote(poll.id, voterId, selections, poll.updatedAt ?? poll.createdAt);
      }
      await prunePollStoreToLimit();
    });
  };

  const getPoll = async (pollId: string) => {
    const poll = await pollStore.lookup(buildFeishuPollStateKey(pollId));
    if (!poll) {
      return null;
    }
    if (!pruneExpiredFeishuPolls({ [pollId]: poll })[pollId]) {
      return null;
    }
    return await reconstructPoll(poll);
  };

  const recordVote = async (vote: { pollId: string; voterId: string; selections: string[] }) => {
    return await withFeishuSqliteMutationLock(options, FEISHU_POLL_MUTATION_KEY, async () => {
      const pollKey = buildFeishuPollStateKey(vote.pollId);
      const poll = await pollStore.lookup(pollKey);
      if (!poll) {
        return null;
      }
      if (!pruneExpiredFeishuPolls({ [vote.pollId]: poll })[vote.pollId]) {
        await pollStore.delete(pollKey);
        await deletePollVotes(vote.pollId);
        return null;
      }
      const currentPoll = await reconstructPoll(poll);
      const normalized = normalizeFeishuPollSelections(currentPoll, vote.selections);
      const updatedAt = new Date().toISOString();
      poll.updatedAt = updatedAt;
      await pollStore.register(pollKey, toPluginJsonValue(poll));
      await registerPollVote(vote.pollId, vote.voterId, normalized, updatedAt);
      await prunePollStoreToLimit();
      return await reconstructPoll(poll);
    });
  };

  return { createPoll, getPoll, recordVote };
}
