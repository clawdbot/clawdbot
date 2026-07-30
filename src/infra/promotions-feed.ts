import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  type ClawHubPromotionsFeedEntry,
  fetchClawHubPromotionsFeed,
  parseClawHubPromotionsFeed,
} from "./clawhub.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

// Passive-discovery cache for the ClawHub promotions feed. Deliberately a
// separate store from `update_check_state`: promo discovery must never
// delay, break, or contend with update checks. The cache is best-effort —
// every reader falls back to "no promotions" on any storage or parse error,
// and `promos claim` always revalidates against the live API.

const PROMOTIONS_FEED_STATE_KEY = "default";
const PROMOTIONS_FEED_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Refreshes run inline from interactive commands, so they get a short
// timeout (matching the update check's 2.5s) instead of ClawHub's default
// 30s — a blackholed connection must not stall `models list`.
const PROMOTIONS_FEED_FETCH_TIMEOUT_MS = 2500;

type PromotionsFeedDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "clawhub_promotions_feed_state" | "clawhub_promotion_claims"
>;

type PromotionsFeedState = {
  etag?: string;
  sequence?: number;
  expiresAtMs?: number;
  entries: ClawHubPromotionsFeedEntry[];
  lastCheckedAtMs?: number;
  notifiedSlugs: Set<string>;
};

type PromotionClaimRecord = {
  slug: string;
  provider?: string;
  modelKeys: string[];
  endsAtMs: number;
  claimedAtMs: number;
};

const EMPTY_STATE: PromotionsFeedState = { entries: [], notifiedSlugs: new Set() };

type PromotionsFeedStateRead = {
  state: PromotionsFeedState;
  payloadInvalid: boolean;
};

function parseSlugListJson(raw: string | null): Set<string> {
  if (!raw) {
    return new Set();
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    return new Set();
  }
  return new Set(parsed.filter((entry): entry is string => typeof entry === "string"));
}

function readPromotionsFeedStateWithMetadata(): PromotionsFeedStateRead {
  try {
    const database = openOpenClawStateDatabase();
    const db = getNodeSqliteKysely<PromotionsFeedDatabase>(database.db);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("clawhub_promotions_feed_state")
        .select([
          "etag",
          "payload_json",
          "feed_sequence",
          "last_checked_at_ms",
          "notified_slugs_json",
        ])
        .where("state_key", "=", PROMOTIONS_FEED_STATE_KEY),
    );
    if (!row) {
      return {
        state: { ...EMPTY_STATE, notifiedSlugs: new Set() },
        payloadInvalid: false,
      };
    }
    let entries: ClawHubPromotionsFeedEntry[] = [];
    let expiresAtMs: number | undefined;
    let payloadInvalid = false;
    if (row.payload_json) {
      try {
        const feed = parseClawHubPromotionsFeed(JSON.parse(row.payload_json));
        entries = feed.entries;
        expiresAtMs = Date.parse(feed.expiresAt);
      } catch {
        payloadInvalid = true;
      }
    }
    return {
      state: {
        ...(!payloadInvalid && row.etag ? { etag: row.etag } : {}),
        ...(!payloadInvalid && typeof row.feed_sequence === "number"
          ? { sequence: row.feed_sequence }
          : {}),
        ...(!payloadInvalid && expiresAtMs !== undefined ? { expiresAtMs } : {}),
        entries,
        ...(typeof row.last_checked_at_ms === "number"
          ? { lastCheckedAtMs: row.last_checked_at_ms }
          : {}),
        notifiedSlugs: parseSlugListJson(row.notified_slugs_json),
      },
      payloadInvalid,
    };
  } catch {
    return {
      state: { ...EMPTY_STATE, notifiedSlugs: new Set() },
      payloadInvalid: false,
    };
  }
}

function readPromotionsFeedState(): PromotionsFeedState {
  return readPromotionsFeedStateWithMetadata().state;
}

type WritePromotionsFeedStateParams = {
  etag?: string | null;
  sequence?: number | null;
  payloadJson?: string | null;
  lastCheckedAtMs?: number;
  notifiedSlugs?: Set<string>;
};

function writePromotionsFeedState(params: WritePromotionsFeedStateParams): void {
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<PromotionsFeedDatabase>(database.db);
    const existing = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("clawhub_promotions_feed_state")
        .select([
          "etag",
          "payload_json",
          "feed_sequence",
          "last_checked_at_ms",
          "notified_slugs_json",
        ])
        .where("state_key", "=", PROMOTIONS_FEED_STATE_KEY),
    );
    const next = {
      etag: params.etag === undefined ? (existing?.etag ?? null) : params.etag,
      payload_json:
        params.payloadJson === undefined ? (existing?.payload_json ?? null) : params.payloadJson,
      feed_sequence:
        params.sequence === undefined ? (existing?.feed_sequence ?? null) : params.sequence,
      last_checked_at_ms: params.lastCheckedAtMs ?? existing?.last_checked_at_ms ?? null,
      notified_slugs_json: params.notifiedSlugs
        ? JSON.stringify([...params.notifiedSlugs].toSorted())
        : (existing?.notified_slugs_json ?? "[]"),
      updated_at_ms: Date.now(),
    };
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("clawhub_promotions_feed_state")
        .values({ state_key: PROMOTIONS_FEED_STATE_KEY, ...next })
        .onConflict((conflict) => conflict.column("state_key").doUpdateSet(next)),
    );
  });
}

export function markPromotionSlugsNotified(slugs: Iterable<string>): void {
  try {
    const state = readPromotionsFeedState();
    const merged = new Set(state.notifiedSlugs);
    let changed = false;
    for (const slug of slugs) {
      if (!merged.has(slug)) {
        merged.add(slug);
        changed = true;
      }
    }
    if (changed) {
      writePromotionsFeedState({ notifiedSlugs: merged });
    }
  } catch {
    // Best-effort: a failed marker write only risks repeating a notice.
  }
}

function isPromotionWindowLive(
  entry: Pick<ClawHubPromotionsFeedEntry, "startsAt" | "endsAt">,
  nowMs: number,
): boolean {
  return entry.startsAt <= nowMs && nowMs <= entry.endsAt;
}

export function listLivePromotionEntries(
  state: PromotionsFeedState,
  nowMs: number,
): ClawHubPromotionsFeedEntry[] {
  if (state.expiresAtMs !== undefined && nowMs >= state.expiresAtMs) {
    return [];
  }
  return state.entries.filter((entry) => isPromotionWindowLive(entry, nowMs));
}

type RefreshPromotionsFeedParams = {
  nowMs?: number;
  force?: boolean;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
};

/**
 * Cadence-gated, fail-silent feed refresh. At most one conditional GET per
 * check interval; offline or malformed responses leave the cached state
 * untouched (aside from the attempt timestamp, so failures do not retry on
 * every command). Returns the freshest available state.
 */
export async function maybeRefreshPromotionsFeed(
  params: RefreshPromotionsFeedParams = {},
): Promise<PromotionsFeedState> {
  const { state, payloadInvalid } = readPromotionsFeedStateWithMetadata();
  const nowMs = params.nowMs ?? Date.now();
  // Never hit the network from unit tests unless the test injects a fetch.
  const skipForTests =
    !params.fetchImpl && (process.env.VITEST !== undefined || process.env.NODE_ENV === "test");
  // Revalidate when a snapshot reaches its producer-declared expiry. Once an
  // expiry refresh has been attempted, lastCheckedAtMs moves past that horizon
  // so an offline/304 response stays hidden without retrying on every command.
  const checkedBeforeSnapshotExpired =
    state.expiresAtMs !== undefined &&
    state.lastCheckedAtMs !== undefined &&
    state.lastCheckedAtMs < state.expiresAtMs;
  const fresh =
    !payloadInvalid &&
    state.lastCheckedAtMs !== undefined &&
    nowMs - state.lastCheckedAtMs < PROMOTIONS_FEED_CHECK_INTERVAL_MS &&
    (!checkedBeforeSnapshotExpired || state.expiresAtMs === undefined || nowMs < state.expiresAtMs);
  if (skipForTests || (fresh && !params.force)) {
    return state;
  }
  try {
    const result = await fetchClawHubPromotionsFeed({
      ...(state.etag ? { etag: state.etag } : {}),
      ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
      timeoutMs: params.timeoutMs ?? PROMOTIONS_FEED_FETCH_TIMEOUT_MS,
    });
    if (result.status === "not-modified") {
      writePromotionsFeedState({ lastCheckedAtMs: nowMs });
      return { ...state, lastCheckedAtMs: nowMs };
    }
    // Snapshots are monotonic; never replace cached state with an older
    // sequence a stale edge might still serve.
    if (state.sequence !== undefined && result.feed.sequence < state.sequence) {
      writePromotionsFeedState({ lastCheckedAtMs: nowMs });
      return { ...state, lastCheckedAtMs: nowMs };
    }
    writePromotionsFeedState({
      etag: result.etag ?? null,
      sequence: result.feed.sequence,
      payloadJson: result.payload,
      lastCheckedAtMs: nowMs,
    });
    return {
      ...(result.etag ? { etag: result.etag } : {}),
      sequence: result.feed.sequence,
      expiresAtMs: Date.parse(result.feed.expiresAt),
      entries: result.feed.entries,
      lastCheckedAtMs: nowMs,
      notifiedSlugs: state.notifiedSlugs,
    };
  } catch {
    try {
      writePromotionsFeedState({
        ...(payloadInvalid ? { etag: null, sequence: null, payloadJson: null } : {}),
        lastCheckedAtMs: nowMs,
      });
    } catch {
      // Storage unavailable: stay fully in-memory for this invocation.
    }
    return { ...state, lastCheckedAtMs: nowMs };
  }
}

export function recordPromotionClaim(record: PromotionClaimRecord): void {
  try {
    runOpenClawStateWriteTransaction((database) => {
      const db = getNodeSqliteKysely<PromotionsFeedDatabase>(database.db);
      const values = {
        slug: record.slug,
        provider: record.provider ?? null,
        model_keys_json: JSON.stringify(record.modelKeys),
        ends_at_ms: record.endsAtMs,
        claimed_at_ms: record.claimedAtMs,
      };
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("clawhub_promotion_claims")
          .values(values)
          .onConflict((conflict) => conflict.column("slug").doUpdateSet(values)),
      );
    });
  } catch {
    // Provenance is annotation-only; a failed write must never fail a claim.
  }
}

export function readPromotionClaims(): PromotionClaimRecord[] {
  try {
    const database = openOpenClawStateDatabase();
    const db = getNodeSqliteKysely<PromotionsFeedDatabase>(database.db);
    const { rows } = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("clawhub_promotion_claims")
        .select(["slug", "provider", "model_keys_json", "ends_at_ms", "claimed_at_ms"]),
    );
    return rows.map((row) => {
      let modelKeys: string[] = [];
      try {
        const parsed = JSON.parse(row.model_keys_json) as unknown;
        if (Array.isArray(parsed)) {
          modelKeys = parsed.filter((entry): entry is string => typeof entry === "string");
        }
      } catch {
        // Ignore malformed provenance rows; they only power annotations.
      }
      const record: PromotionClaimRecord = {
        slug: row.slug,
        modelKeys,
        endsAtMs: row.ends_at_ms,
        claimedAtMs: row.claimed_at_ms,
      };
      if (row.provider) {
        record.provider = row.provider;
      }
      return record;
    });
  } catch {
    return [];
  }
}
