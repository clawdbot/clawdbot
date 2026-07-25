// Msteams plugin module implements polls behavior.
import crypto from "node:crypto";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  isRecord,
  normalizeOptionalString,
  normalizeStringEntries,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { getMSTeamsRuntime } from "./runtime.js";
import {
  resolveMSTeamsSqliteStateEnv,
  toPluginJsonValue,
  withMSTeamsSqliteMutationLock,
} from "./sqlite-state.js";

type MSTeamsPollVote = {
  pollId: string;
  selections: string[];
};

export type MSTeamsPoll = {
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

export type MSTeamsPollStore = {
  createPoll: (poll: MSTeamsPoll) => Promise<void>;
  getPoll: (pollId: string) => Promise<MSTeamsPoll | null>;
  recordVote: (params: {
    pollId: string;
    voterId: string;
    selections: string[];
  }) => Promise<MSTeamsPoll | null>;
};

type MSTeamsPollCard = {
  pollId: string;
  question: string;
  options: string[];
  maxSelections: number;
  card: Record<string, unknown>;
  fallbackText: string;
};

export type MSTeamsPollStoreData = {
  version: 1;
  polls: Record<string, MSTeamsPoll>;
};

export type StoredMSTeamsPoll = Omit<MSTeamsPoll, "votes">;

export type StoredMSTeamsPollVoteBucket = {
  pollId: string;
  bucket: string;
  votes: Record<string, string[]>;
  updatedAt: string;
};

export const MSTEAMS_POLLS_LEGACY_FILENAME = "msteams-polls.json";
export const MSTEAMS_POLLS_NAMESPACE = "polls";
export const MSTEAMS_POLL_VOTE_BUCKETS_NAMESPACE = "poll-vote-buckets";
const MSTEAMS_MAX_POLLS = 1000;
export const MSTEAMS_SQLITE_MAX_POLL_ROWS = MSTEAMS_MAX_POLLS + 1000;
// Keep worst-case retained vote buckets below plugin-state's per-plugin live row cap.
const MSTEAMS_POLL_VOTE_BUCKET_COUNT = 32;
export const MSTEAMS_MAX_POLL_VOTE_BUCKET_ROWS =
  (MSTEAMS_MAX_POLLS + 1) * MSTEAMS_POLL_VOTE_BUCKET_COUNT;
const MSTEAMS_POLL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const POLL_MUTATION_KEY = "polls";

function normalizeChoiceValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function extractSelections(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(normalizeChoiceValue).filter((entry): entry is string => Boolean(entry));
  }
  const normalized = normalizeChoiceValue(value);
  if (!normalized) {
    return [];
  }
  if (normalized.includes(",")) {
    return normalizeStringEntries(normalized.split(","));
  }
  return [normalized];
}

function readNestedValue(value: unknown, keys: Array<string | number>): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key as keyof typeof current];
  }
  return current;
}

function readNestedString(value: unknown, keys: Array<string | number>): string | undefined {
  return normalizeOptionalString(readNestedValue(value, keys));
}

export function extractMSTeamsPollVote(
  activity: { value?: unknown } | undefined,
): MSTeamsPollVote | null {
  const value = activity?.value;
  if (!value || !isRecord(value)) {
    return null;
  }
  const pollId =
    readNestedString(value, ["openclawPollId"]) ??
    readNestedString(value, ["pollId"]) ??
    readNestedString(value, ["openclaw", "pollId"]) ??
    readNestedString(value, ["openclaw", "poll", "id"]) ??
    readNestedString(value, ["data", "openclawPollId"]) ??
    readNestedString(value, ["data", "pollId"]) ??
    readNestedString(value, ["data", "openclaw", "pollId"]) ??
    // Action.Execute (Universal Action Model) payload shape: value.action.data
    readNestedString(value, ["action", "data", "openclawPollId"]) ??
    readNestedString(value, ["action", "data", "pollId"]);
  if (!pollId) {
    return null;
  }

  const directSelections = extractSelections(value.choices);
  const nestedSelections = extractSelections(readNestedValue(value, ["choices"]));
  const dataSelections = extractSelections(readNestedValue(value, ["data", "choices"]));
  const actionDataSelections = extractSelections(
    readNestedValue(value, ["action", "data", "choices"]),
  );
  const selections =
    directSelections.length > 0
      ? directSelections
      : nestedSelections.length > 0
        ? nestedSelections
        : dataSelections.length > 0
          ? dataSelections
          : actionDataSelections;

  if (selections.length === 0) {
    return null;
  }

  return {
    pollId,
    selections,
  };
}

export function buildMSTeamsPollCard(params: {
  question: string;
  options: string[];
  maxSelections?: number;
  pollId?: string;
}): MSTeamsPollCard {
  const pollId = params.pollId ?? crypto.randomUUID();
  const maxSelections =
    typeof params.maxSelections === "number" && params.maxSelections > 1
      ? Math.floor(params.maxSelections)
      : 1;
  const cappedMaxSelections = Math.min(Math.max(1, maxSelections), params.options.length);
  const choices = params.options.map((option, index) => ({
    title: option,
    value: String(index),
  }));
  const hint =
    cappedMaxSelections > 1
      ? `Select up to ${cappedMaxSelections} option${cappedMaxSelections === 1 ? "" : "s"}.`
      : "Select one option.";

  const card = {
    type: "AdaptiveCard",
    version: "1.5",
    body: [
      {
        type: "TextBlock",
        text: params.question,
        wrap: true,
        weight: "Bolder",
        size: "Medium",
      },
      {
        type: "Input.ChoiceSet",
        id: "choices",
        isMultiSelect: cappedMaxSelections > 1,
        style: "expanded",
        choices,
      },
      {
        type: "TextBlock",
        text: hint,
        wrap: true,
        isSubtle: true,
        spacing: "Small",
      },
    ],
    actions: [
      {
        type: "Action.Execute",
        title: "Vote",
        verb: "openclaw.poll.vote",
        data: {
          openclawPollId: pollId,
          pollId,
        },
      },
    ],
  };

  const fallbackLines = [
    `Poll: ${params.question}`,
    ...params.options.map((option, index) => `${index + 1}. ${option}`),
  ];

  return {
    pollId,
    question: params.question,
    options: params.options,
    maxSelections: cappedMaxSelections,
    card,
    fallbackText: fallbackLines.join("\n"),
  };
}

type MSTeamsPollStoreStateOptions = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
  storePath?: string;
};

function createPollStateStore(params?: MSTeamsPollStoreStateOptions) {
  return getMSTeamsRuntime().state.openKeyedStore<StoredMSTeamsPoll>({
    namespace: MSTEAMS_POLLS_NAMESPACE,
    maxEntries: MSTEAMS_SQLITE_MAX_POLL_ROWS,
    env: resolveMSTeamsSqliteStateEnv(params),
  });
}

function createPollVoteBucketStateStore(params?: MSTeamsPollStoreStateOptions) {
  return getMSTeamsRuntime().state.openKeyedStore<StoredMSTeamsPollVoteBucket>({
    namespace: MSTEAMS_POLL_VOTE_BUCKETS_NAMESPACE,
    maxEntries: MSTEAMS_MAX_POLL_VOTE_BUCKET_ROWS,
    env: resolveMSTeamsSqliteStateEnv(params),
  });
}

function parseTimestamp(value?: string): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pruneExpired<T extends { createdAt: string; updatedAt?: string }>(
  polls: Record<string, T>,
) {
  const cutoff = Date.now() - MSTEAMS_POLL_TTL_MS;
  const entries = Object.entries(polls).filter(([, poll]) => {
    const ts = parseTimestamp(poll.updatedAt ?? poll.createdAt) ?? 0;
    return ts >= cutoff;
  });
  return Object.fromEntries(entries);
}

export function selectRetainedMSTeamsPolls(
  polls: Record<string, MSTeamsPoll>,
): Array<[string, MSTeamsPoll]> {
  const retained = Object.entries(pruneExpired(polls));
  if (retained.length <= MSTEAMS_MAX_POLLS) {
    return retained;
  }
  retained.sort((a, b) => {
    const aTs = parseTimestamp(a[1].updatedAt ?? a[1].createdAt) ?? 0;
    const bTs = parseTimestamp(b[1].updatedAt ?? b[1].createdAt) ?? 0;
    return aTs - bTs || a[0].localeCompare(b[0]);
  });
  return retained.slice(retained.length - MSTEAMS_MAX_POLLS);
}

function normalizeMSTeamsPollSelections(poll: MSTeamsPoll, selections: string[]) {
  const maxSelections = Math.max(1, poll.maxSelections);
  const mapped = selections
    .map((entry) => parseStrictNonNegativeInteger(entry))
    .filter((value): value is number => value !== undefined)
    .filter((value) => value >= 0 && value < poll.options.length)
    .map((value) => String(value));
  const limited = maxSelections > 1 ? mapped.slice(0, maxSelections) : mapped.slice(0, 1);
  return uniqueStrings(limited);
}

export function splitMSTeamsPoll(poll: MSTeamsPoll): {
  metadata: StoredMSTeamsPoll;
  votes: MSTeamsPoll["votes"];
} {
  const { votes, ...metadata } = poll;
  return { metadata, votes };
}

function hashMSTeamsPollVote(pollId: string, voterId: string): string {
  return crypto.createHash("sha256").update(pollId).update("\0").update(voterId).digest("hex");
}

export function buildMSTeamsPollStateKey(pollId: string): string {
  return crypto.createHash("sha256").update(pollId).digest("hex");
}

export function selectMSTeamsPollVoteBucket(pollId: string, voterId: string): string {
  const bucket = Number.parseInt(hashMSTeamsPollVote(pollId, voterId).slice(0, 8), 16);
  return String(bucket % MSTEAMS_POLL_VOTE_BUCKET_COUNT).padStart(4, "0");
}

export function buildMSTeamsPollVoteBucketKey(pollId: string, bucket: string): string {
  const pollDigest = crypto.createHash("sha256").update(pollId).digest("hex");
  return `${pollDigest}:${bucket}`;
}

export function createMSTeamsPollStoreState(
  params?: MSTeamsPollStoreStateOptions,
): MSTeamsPollStore {
  const pollStore = createPollStateStore(params);
  const voteBucketStore = createPollVoteBucketStateStore(params);

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

  const registerPollVotes = async (
    pollId: string,
    votes: Record<string, string[]>,
    updatedAt: string,
  ): Promise<void> => {
    const buckets = new Map<string, Record<string, string[]>>();
    for (const [voterId, selections] of Object.entries(votes)) {
      const bucket = selectMSTeamsPollVoteBucket(pollId, voterId);
      const bucketVotes = buckets.get(bucket) ?? {};
      bucketVotes[voterId] = selections;
      buckets.set(bucket, bucketVotes);
    }
    for (const [bucket, bucketVotes] of buckets) {
      const key = buildMSTeamsPollVoteBucketKey(pollId, bucket);
      const existing = await voteBucketStore.lookup(key);
      await voteBucketStore.register(
        key,
        toPluginJsonValue({
          pollId,
          bucket,
          votes: { ...bucketVotes, ...existing?.votes },
          updatedAt,
        }),
      );
    }
  };

  const registerPollVote = async (
    pollId: string,
    voterId: string,
    selections: string[],
    updatedAt: string,
  ): Promise<void> => {
    const bucket = selectMSTeamsPollVoteBucket(pollId, voterId);
    const key = buildMSTeamsPollVoteBucketKey(pollId, bucket);
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

  const reconstructPoll = async (metadata: StoredMSTeamsPoll): Promise<MSTeamsPoll> => {
    return { ...metadata, votes: await readPollVotes(metadata.id) };
  };

  const prunePollStoreToLimit = async (): Promise<void> => {
    const rows = [];
    for (const row of await pollStore.entries()) {
      if (!pruneExpired({ [row.key]: row.value })[row.key]) {
        await pollStore.delete(row.key);
        await deletePollVotes(row.value.id);
        continue;
      }
      rows.push(row);
    }
    if (rows.length <= MSTEAMS_MAX_POLLS) {
      return;
    }
    const sorted = rows.toSorted((a, b) => {
      const aTs = parseTimestamp(a.value.updatedAt ?? a.value.createdAt) ?? 0;
      const bTs = parseTimestamp(b.value.updatedAt ?? b.value.createdAt) ?? 0;
      return aTs - bTs || a.key.localeCompare(b.key);
    });
    for (const row of sorted.slice(0, rows.length - MSTEAMS_MAX_POLLS)) {
      await pollStore.delete(row.key);
      await deletePollVotes(row.value.id);
    }
  };

  const createPoll = async (poll: MSTeamsPoll) => {
    await withMSTeamsSqliteMutationLock(params, POLL_MUTATION_KEY, async () => {
      const { metadata, votes } = splitMSTeamsPoll(poll);
      await pollStore.register(buildMSTeamsPollStateKey(poll.id), toPluginJsonValue(metadata));
      await deletePollVotes(poll.id);
      await registerPollVotes(poll.id, votes, poll.updatedAt ?? poll.createdAt);
      await prunePollStoreToLimit();
    });
  };

  const getPoll = async (pollId: string) => {
    const poll = await pollStore.lookup(buildMSTeamsPollStateKey(pollId));
    if (!poll) {
      return null;
    }
    if (!pruneExpired({ [pollId]: poll })[pollId]) {
      return null;
    }
    return await reconstructPoll(poll);
  };

  const recordVote = async (vote: { pollId: string; voterId: string; selections: string[] }) => {
    return await withMSTeamsSqliteMutationLock(params, POLL_MUTATION_KEY, async () => {
      const pollKey = buildMSTeamsPollStateKey(vote.pollId);
      const poll = await pollStore.lookup(pollKey);
      if (!poll) {
        return null;
      }
      if (!pruneExpired({ [vote.pollId]: poll })[vote.pollId]) {
        await pollStore.delete(pollKey);
        await deletePollVotes(vote.pollId);
        return null;
      }
      const currentPoll = await reconstructPoll(poll);
      const normalized = normalizeMSTeamsPollSelections(currentPoll, vote.selections);
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
