import crypto from "node:crypto";
import fs from "node:fs/promises";
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
import { resolveMSTeamsStorePath } from "./storage.js";
import { readJsonFile } from "./store-fs.js";

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

type PollStoreData = {
  version: 1;
  polls: Record<string, MSTeamsPoll>;
};

type StoredMSTeamsPoll = Omit<MSTeamsPoll, "votes">;

type StoredMSTeamsPollVoteBucket = {
  pollId: string;
  bucket: string;
  votes: Record<string, string[]>;
  updatedAt: string;
};

const STORE_FILENAME = "msteams-polls.json";
const POLLS_NAMESPACE = "polls";
const POLL_VOTE_BUCKETS_NAMESPACE = "poll-vote-buckets";
const POLL_MIGRATIONS_NAMESPACE = "poll-migrations";
const LEGACY_POLLS_MIGRATION_KEY = "msteams-polls-json-v1";
const MAX_POLLS = 1000;
const SQLITE_MAX_POLL_ROWS = MAX_POLLS + 1000;
// Keep worst-case retained vote buckets below plugin-state's per-plugin live row cap.
const POLL_VOTE_BUCKET_COUNT = 32;
const MAX_POLL_VOTE_BUCKET_ROWS = (MAX_POLLS + 1) * POLL_VOTE_BUCKET_COUNT;
const POLL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const POLL_LOCK_FILENAME = "msteams-polls.sqlite.lock";

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

type PollMigrationMarker = {
  importedAt: string;
};

function createPollStateStore(params?: MSTeamsPollStoreStateOptions) {
  return getMSTeamsRuntime().state.openKeyedStore<StoredMSTeamsPoll>({
    namespace: POLLS_NAMESPACE,
    maxEntries: SQLITE_MAX_POLL_ROWS,
    env: resolveMSTeamsSqliteStateEnv(params),
  });
}

function createPollVoteBucketStateStore(params?: MSTeamsPollStoreStateOptions) {
  return getMSTeamsRuntime().state.openKeyedStore<StoredMSTeamsPollVoteBucket>({
    namespace: POLL_VOTE_BUCKETS_NAMESPACE,
    maxEntries: MAX_POLL_VOTE_BUCKET_ROWS,
    env: resolveMSTeamsSqliteStateEnv(params),
  });
}

function createPollMigrationStore(params?: MSTeamsPollStoreStateOptions) {
  return getMSTeamsRuntime().state.openKeyedStore<PollMigrationMarker>({
    namespace: POLL_MIGRATIONS_NAMESPACE,
    maxEntries: 100,
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
  const cutoff = Date.now() - POLL_TTL_MS;
  const entries = Object.entries(polls).filter(([, poll]) => {
    const ts = parseTimestamp(poll.updatedAt ?? poll.createdAt) ?? 0;
    return ts >= cutoff;
  });
  return Object.fromEntries(entries);
}

function selectRetainedPolls(polls: Record<string, MSTeamsPoll>): Array<[string, MSTeamsPoll]> {
  const retained = Object.entries(pruneExpired(polls));
  if (retained.length <= MAX_POLLS) {
    return retained;
  }
  retained.sort((a, b) => {
    const aTs = parseTimestamp(a[1].updatedAt ?? a[1].createdAt) ?? 0;
    const bTs = parseTimestamp(b[1].updatedAt ?? b[1].createdAt) ?? 0;
    return aTs - bTs || a[0].localeCompare(b[0]);
  });
  return retained.slice(retained.length - MAX_POLLS);
}

export function normalizeMSTeamsPollSelections(poll: MSTeamsPoll, selections: string[]) {
  const maxSelections = Math.max(1, poll.maxSelections);
  const mapped = selections
    .map((entry) => parseStrictNonNegativeInteger(entry))
    .filter((value): value is number => value !== undefined)
    .filter((value) => value >= 0 && value < poll.options.length)
    .map((value) => String(value));
  const limited = maxSelections > 1 ? mapped.slice(0, maxSelections) : mapped.slice(0, 1);
  return uniqueStrings(limited);
}

export function createMSTeamsPollStoreState(
  params?: MSTeamsPollStoreStateOptions,
): MSTeamsPollStore {
  const pollStore = createPollStateStore(params);
  const voteBucketStore = createPollVoteBucketStateStore(params);
  const migrationStore = createPollMigrationStore(params);
  const legacyStorePath = resolveMSTeamsStorePath({
    filename: STORE_FILENAME,
    env: params?.env,
    homedir: params?.homedir,
    stateDir: params?.stateDir,
    storePath: params?.storePath,
  });
  let legacyImportPromise: Promise<void> | null = null;

  const splitPoll = (
    poll: MSTeamsPoll,
  ): { metadata: StoredMSTeamsPoll; votes: MSTeamsPoll["votes"] } => {
    const { votes, ...metadata } = poll;
    return { metadata, votes };
  };

  const hashVote = (pollId: string, voterId: string): string => {
    return crypto.createHash("sha256").update(pollId).update("\0").update(voterId).digest("hex");
  };

  const buildPollStateKey = (pollId: string): string => {
    return crypto.createHash("sha256").update(pollId).digest("hex");
  };

  const selectVoteBucket = (pollId: string, voterId: string): string => {
    const bucket = Number.parseInt(hashVote(pollId, voterId).slice(0, 8), 16);
    return String(bucket % POLL_VOTE_BUCKET_COUNT).padStart(4, "0");
  };

  const buildVoteBucketKey = (pollId: string, bucket: string): string => {
    const pollDigest = crypto.createHash("sha256").update(pollId).digest("hex");
    return `${pollDigest}:${bucket}`;
  };

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
      const bucket = selectVoteBucket(pollId, voterId);
      const bucketVotes = buckets.get(bucket) ?? {};
      bucketVotes[voterId] = selections;
      buckets.set(bucket, bucketVotes);
    }
    for (const [bucket, bucketVotes] of buckets) {
      const key = buildVoteBucketKey(pollId, bucket);
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
    const bucket = selectVoteBucket(pollId, voterId);
    const key = buildVoteBucketKey(pollId, bucket);
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

  const importLegacyStore = async (): Promise<void> => {
    if (await migrationStore.lookup(LEGACY_POLLS_MIGRATION_KEY)) {
      return;
    }
    const empty: PollStoreData = { version: 1, polls: {} };
    const { value, exists } = await readJsonFile<PollStoreData>(legacyStorePath, empty);
    if (!exists) {
      await migrationStore.register(LEGACY_POLLS_MIGRATION_KEY, {
        importedAt: new Date().toISOString(),
      });
      return;
    }
    const legacyPolls =
      value.version === 1 &&
      value.polls &&
      typeof value.polls === "object" &&
      !Array.isArray(value.polls)
        ? value.polls
        : {};
    for (const [pollId, poll] of selectRetainedPolls(legacyPolls)) {
      if (!pollId) {
        continue;
      }
      const { metadata, votes } = splitPoll(poll);
      await pollStore.registerIfAbsent(buildPollStateKey(pollId), toPluginJsonValue(metadata));
      await registerPollVotes(pollId, votes, poll.updatedAt ?? poll.createdAt);
    }
    await migrationStore.register(LEGACY_POLLS_MIGRATION_KEY, {
      importedAt: new Date().toISOString(),
    });
    await fs.rm(legacyStorePath, { force: true }).catch(() => {});
  };

  const ensureLegacyImported = async (): Promise<void> => {
    legacyImportPromise ??= withMSTeamsSqliteMutationLock(
      params,
      POLL_LOCK_FILENAME,
      importLegacyStore,
    );
    await legacyImportPromise;
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
    if (rows.length <= MAX_POLLS) {
      return;
    }
    const sorted = rows.toSorted((a, b) => {
      const aTs = parseTimestamp(a.value.updatedAt ?? a.value.createdAt) ?? 0;
      const bTs = parseTimestamp(b.value.updatedAt ?? b.value.createdAt) ?? 0;
      return aTs - bTs || a.key.localeCompare(b.key);
    });
    for (const row of sorted.slice(0, rows.length - MAX_POLLS)) {
      await pollStore.delete(row.key);
      await deletePollVotes(row.value.id);
    }
  };

  const createPoll = async (poll: MSTeamsPoll) => {
    await withMSTeamsSqliteMutationLock(params, POLL_LOCK_FILENAME, async () => {
      await importLegacyStore();
      const { metadata, votes } = splitPoll(poll);
      await pollStore.register(buildPollStateKey(poll.id), toPluginJsonValue(metadata));
      await deletePollVotes(poll.id);
      await registerPollVotes(poll.id, votes, poll.updatedAt ?? poll.createdAt);
      await prunePollStoreToLimit();
    });
  };

  const getPoll = async (pollId: string) => {
    await ensureLegacyImported();
    const poll = await pollStore.lookup(buildPollStateKey(pollId));
    if (!poll) {
      return null;
    }
    if (!pruneExpired({ [pollId]: poll })[pollId]) {
      return null;
    }
    return await reconstructPoll(poll);
  };

  const recordVote = async (vote: { pollId: string; voterId: string; selections: string[] }) => {
    return await withMSTeamsSqliteMutationLock(params, POLL_LOCK_FILENAME, async () => {
      await importLegacyStore();
      const pollKey = buildPollStateKey(vote.pollId);
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
