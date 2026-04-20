import { createHash } from "node:crypto";
import path from "node:path";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { resolveBlueBubblesServerAccount } from "./account-resolve.js";
import { createBlueBubblesClientFromParts } from "./client.js";
import { warmupBlueBubblesInboundDedupe } from "./inbound-dedupe.js";
import { asRecord, normalizeWebhookMessage } from "./monitor-normalize.js";
import { processMessage } from "./monitor-processing.js";
import type { WebhookTarget } from "./monitor-shared.js";

// When the gateway is down, restarting, or wedged, inbound webhook POSTs from
// BB Server fail with ECONNRESET/ECONNREFUSED. BB's WebhookService does not
// retry, and its MessagePoller only re-fires webhooks on BB-side reconnect
// events (Messages.app / APNs), not on webhook-receiver recovery. Without a
// recovery pass, messages delivered during outage windows are permanently
// lost. See #66721 for design discussion and experimental validation.

const DEFAULT_MAX_AGE_MINUTES = 120;
const MAX_MAX_AGE_MINUTES = 12 * 60;
const DEFAULT_PER_RUN_LIMIT = 50;
const MAX_PER_RUN_LIMIT = 500;
const DEFAULT_FIRST_RUN_LOOKBACK_MINUTES = 30;
const DEFAULT_MAX_FAILURE_RETRIES = 10;
const MAX_MAX_FAILURE_RETRIES = 1_000;
// Defense-in-depth bound: a runaway retry map (e.g., a storm of unique
// failing GUIDs) should not balloon the cursor file unboundedly. When the
// map exceeds this size, we keep only the highest-count entries (the ones
// closest to being given up) and drop the rest. Realistic backlogs stay
// well under this; the bound exists to cap pathological growth.
const MAX_FAILURE_RETRY_MAP_SIZE = 5_000;
const FETCH_TIMEOUT_MS = 15_000;

export type BlueBubblesCatchupConfig = {
  enabled?: boolean;
  maxAgeMinutes?: number;
  perRunLimit?: number;
  firstRunLookbackMinutes?: number;
  /**
   * Per-message retry ceiling. After this many consecutive failed
   * `processMessage` attempts against the same GUID, catchup logs a WARN
   * and force-advances the cursor past the wedged message instead of
   * holding it indefinitely. Defaults to 10. Clamped to [1, 1000].
   */
  maxFailureRetries?: number;
};

export type BlueBubblesCatchupSummary = {
  querySucceeded: boolean;
  replayed: number;
  skippedFromMe: number;
  skippedPreCursor: number;
  /**
   * Messages whose GUID was already recorded as "given up" from a previous
   * run (count >= `maxFailureRetries`). These are skipped without calling
   * `processMessage` again. Lets the cursor continue advancing past the
   * wedged message on the next sweep while avoiding another failed attempt.
   */
  skippedGivenUp: number;
  failed: number;
  /**
   * Messages that crossed the `maxFailureRetries` ceiling ON THIS RUN.
   * Each transition triggers a WARN log line. Already-given-up messages
   * in subsequent runs count under `skippedGivenUp`, not here. Lets
   * operators distinguish fresh give-up events from steady-state skips.
   */
  givenUp: number;
  cursorBefore: number | null;
  cursorAfter: number;
  windowStartMs: number;
  windowEndMs: number;
  fetchedCount: number;
};

export type BlueBubblesCatchupCursor = {
  lastSeenMs: number;
  updatedAt: number;
  /**
   * Per-GUID failure counter, preserved across runs. Two states:
   * - `1 <= count < maxFailureRetries`: the GUID is still retrying and
   *   continues to hold the cursor back.
   * - `count >= maxFailureRetries`: catchup has "given up" on the GUID.
   *   The message is skipped on sight (no `processMessage` attempt) and
   *   the GUID no longer holds the cursor. The entry stays in the map
   *   until the cursor naturally advances past the message's timestamp
   *   (at which point the message stops appearing in queries entirely).
   *
   * A successful `processMessage` removes the entry. Optional on the
   * persisted shape so older cursor files without this field load cleanly.
   */
  failureRetries?: Record<string, number>;
};

function resolveStateDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  // Explicit OPENCLAW_STATE_DIR overrides take precedence (including
  // per-test mkdtemp dirs in this module's test suite).
  if (env.OPENCLAW_STATE_DIR?.trim()) {
    return resolveStateDir(env);
  }
  // Default test isolation: per-pid tmpdir, no bleed into real ~/.openclaw.
  // Use resolvePreferredOpenClawTmpDir + string concat (mirrors
  // inbound-dedupe) so this doesn't trip the tmpdir-path-guard test that
  // flags dynamic template-literal suffixes on os.tmpdir() paths.
  if (env.VITEST || env.NODE_ENV === "test") {
    const name = "openclaw-vitest-" + process.pid;
    return path.join(resolvePreferredOpenClawTmpDir(), name);
  }
  // Canonical OpenClaw state dir: honors `~` expansion + legacy/new
  // fallback. Sharing this resolver with inbound-dedupe is what guarantees
  // the catchup cursor and the dedupe state always live under the same
  // root, so a replayed GUID is recognized by the dedupe after catchup
  // re-feeds the message through processMessage.
  return resolveStateDir(env);
}

function resolveCursorFilePath(accountId: string): string {
  // Match inbound-dedupe's file layout: readable prefix + short hash so
  // account IDs that only differ by filesystem-unsafe characters do not
  // collapse onto the same file.
  const safePrefix = accountId.replace(/[^a-zA-Z0-9_-]/g, "_") || "account";
  const hash = createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 12);
  return path.join(
    resolveStateDirFromEnv(),
    "bluebubbles",
    "catchup",
    `${safePrefix}__${hash}.json`,
  );
}

function sanitizeFailureRetriesInput(raw: unknown): Record<string, number> {
  // Older cursor files don't carry this field; also guard against
  // hand-edited JSON or future shape drift. Drop any entry whose count is
  // not a finite positive integer so downstream arithmetic stays sound.
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const out: Record<string, number> = {};
  for (const [guid, count] of Object.entries(raw as Record<string, unknown>)) {
    if (!guid || typeof guid !== "string") {
      continue;
    }
    if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
      continue;
    }
    out[guid] = Math.floor(count);
  }
  return out;
}

export async function loadBlueBubblesCatchupCursor(
  accountId: string,
): Promise<BlueBubblesCatchupCursor | null> {
  const filePath = resolveCursorFilePath(accountId);
  const { value } = await readJsonFileWithFallback<BlueBubblesCatchupCursor | null>(filePath, null);
  if (!value || typeof value !== "object") {
    return null;
  }
  if (typeof value.lastSeenMs !== "number" || !Number.isFinite(value.lastSeenMs)) {
    return null;
  }
  const failureRetries = sanitizeFailureRetriesInput(value.failureRetries);
  const hasRetries = Object.keys(failureRetries).length > 0;
  // Keep the shape consistent with what the writer emits: only carry the
  // `failureRetries` key when there's something to retry. Old cursor files
  // without the field continue to round-trip to the same shape.
  return {
    lastSeenMs: value.lastSeenMs,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
    ...(hasRetries ? { failureRetries } : {}),
  };
}

export async function saveBlueBubblesCatchupCursor(
  accountId: string,
  lastSeenMs: number,
  failureRetries?: Record<string, number>,
): Promise<void> {
  const filePath = resolveCursorFilePath(accountId);
  const sanitized = sanitizeFailureRetriesInput(failureRetries);
  const hasRetries = Object.keys(sanitized).length > 0;
  const cursor: BlueBubblesCatchupCursor = {
    lastSeenMs,
    updatedAt: Date.now(),
    // Only emit the field when non-empty so unrelated cursor writes from
    // the happy path don't bloat the cursor file with `"failureRetries": {}`.
    ...(hasRetries ? { failureRetries: sanitized } : {}),
  };
  await writeJsonFileAtomically(filePath, cursor);
}

/**
 * Bound the retry map so a pathological storm of unique failing GUIDs
 * cannot grow the cursor file without limit. Keeps the `maxSize` entries
 * with the highest counts (closest to give-up) when over the bound.
 *
 * The map is already scoped to "currently failing, still-retrying" GUIDs
 * and prunes on every run (entries not observed in the fetched window are
 * dropped), so this is a defense-in-depth cap, not the primary pruning
 * mechanism.
 */
function capFailureRetriesMap(
  map: Record<string, number>,
  maxSize: number,
): Record<string, number> {
  const entries = Object.entries(map);
  if (entries.length <= maxSize) {
    return map;
  }
  // Sort by count desc; stable tiebreak on guid string so the retained set
  // is deterministic across runs (important for cursor-file diffing during
  // debugging).
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const capped: Record<string, number> = {};
  for (let i = 0; i < maxSize; i++) {
    const [guid, count] = entries[i];
    capped[guid] = count;
  }
  return capped;
}

type FetchOpts = {
  baseUrl: string;
  password: string;
  allowPrivateNetwork: boolean;
  timeoutMs?: number;
};

export type BlueBubblesCatchupFetchResult = {
  resolved: boolean;
  messages: Array<Record<string, unknown>>;
};

export async function fetchBlueBubblesMessagesSince(
  sinceMs: number,
  limit: number,
  opts: FetchOpts,
): Promise<BlueBubblesCatchupFetchResult> {
  const client = createBlueBubblesClientFromParts({
    baseUrl: opts.baseUrl,
    password: opts.password,
    allowPrivateNetwork: opts.allowPrivateNetwork,
    timeoutMs: opts.timeoutMs ?? FETCH_TIMEOUT_MS,
  });
  try {
    const res = await client.request({
      method: "POST",
      path: "/api/v1/message/query",
      body: {
        limit,
        sort: "ASC",
        after: sinceMs,
        // `with` mirrors what bb-catchup.sh uses and what the normal webhook
        // payload carries, so normalizeWebhookMessage has the same fields to
        // read during replay as it does on live dispatch.
        with: ["chat", "chat.participants", "attachment"],
      },
      timeoutMs: opts.timeoutMs ?? FETCH_TIMEOUT_MS,
    });
    if (!res.ok) {
      return { resolved: false, messages: [] };
    }
    const json = (await res.json().catch(() => null)) as { data?: unknown } | null;
    if (!json || !Array.isArray(json.data)) {
      return { resolved: false, messages: [] };
    }
    const messages: Array<Record<string, unknown>> = [];
    for (const entry of json.data) {
      const rec = asRecord(entry);
      if (rec) {
        messages.push(rec);
      }
    }
    return { resolved: true, messages };
  } catch {
    return { resolved: false, messages: [] };
  }
}

function clampCatchupConfig(raw?: BlueBubblesCatchupConfig) {
  const maxAgeMinutes = Math.min(
    Math.max(raw?.maxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES, 1),
    MAX_MAX_AGE_MINUTES,
  );
  const perRunLimit = Math.min(
    Math.max(raw?.perRunLimit ?? DEFAULT_PER_RUN_LIMIT, 1),
    MAX_PER_RUN_LIMIT,
  );
  const firstRunLookbackMinutes = Math.min(
    Math.max(raw?.firstRunLookbackMinutes ?? DEFAULT_FIRST_RUN_LOOKBACK_MINUTES, 1),
    MAX_MAX_AGE_MINUTES,
  );
  const maxFailureRetries = Math.min(
    Math.max(Math.floor(raw?.maxFailureRetries ?? DEFAULT_MAX_FAILURE_RETRIES), 1),
    MAX_MAX_FAILURE_RETRIES,
  );
  return {
    maxAgeMs: maxAgeMinutes * 60_000,
    perRunLimit,
    firstRunLookbackMs: firstRunLookbackMinutes * 60_000,
    maxFailureRetries,
  };
}

export type RunBlueBubblesCatchupDeps = {
  fetchMessages?: typeof fetchBlueBubblesMessagesSince;
  processMessageFn?: typeof processMessage;
  now?: () => number;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

/**
 * Fetch and replay BlueBubbles messages delivered since the persisted
 * catchup cursor, feeding each through the same `processMessage` pipeline
 * live webhooks use. Safe to call on every gateway startup: replays that
 * collide with #66230's inbound dedupe cache are dropped there, so a
 * message already processed via live webhook will not be processed twice.
 *
 * Returns the run summary, or `null` when disabled or aborted before the
 * first query.
 *
 * Concurrent calls for the same accountId are coalesced into a single
 * in-flight run via a module-level singleflight map. Without this, a
 * fire-and-forget trigger (monitor.ts) combined with an overlapping
 * webhook-target re-registration could race: two runs would read the
 * same cursor, compute divergent `nextCursorMs` values, and the last
 * writer could regress the cursor — causing repeated replay of the same
 * backlog on every subsequent startup.
 */
const inFlightCatchups = new Map<string, Promise<BlueBubblesCatchupSummary | null>>();

export function runBlueBubblesCatchup(
  target: WebhookTarget,
  deps: RunBlueBubblesCatchupDeps = {},
): Promise<BlueBubblesCatchupSummary | null> {
  const accountId = target.account.accountId;
  const existing = inFlightCatchups.get(accountId);
  if (existing) {
    return existing;
  }
  const runPromise = runBlueBubblesCatchupInner(target, deps).finally(() => {
    inFlightCatchups.delete(accountId);
  });
  inFlightCatchups.set(accountId, runPromise);
  return runPromise;
}

async function runBlueBubblesCatchupInner(
  target: WebhookTarget,
  deps: RunBlueBubblesCatchupDeps,
): Promise<BlueBubblesCatchupSummary | null> {
  const raw = (target.account.config as { catchup?: BlueBubblesCatchupConfig }).catchup;
  if (raw?.enabled === false) {
    return null;
  }

  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? target.runtime.log;
  const error = deps.error ?? target.runtime.error;
  const fetchFn = deps.fetchMessages ?? fetchBlueBubblesMessagesSince;
  const procFn = deps.processMessageFn ?? processMessage;
  const accountId = target.account.accountId;

  const { maxAgeMs, perRunLimit, firstRunLookbackMs, maxFailureRetries } = clampCatchupConfig(raw);
  const nowMs = now();
  const existing = await loadBlueBubblesCatchupCursor(accountId).catch(() => null);
  const cursorBefore = existing?.lastSeenMs ?? null;
  const prevRetries = existing?.failureRetries ?? {};

  // Catchup runs once per gateway startup (called from monitor.ts after
  // webhook target registration). We deliberately do NOT short-circuit on
  // a "ran recently" gate, because catchup is the only mechanism that
  // recovers messages dropped during the gateway-down window. A short
  // gap (e.g. <30s) between two startups can still have lost messages in
  // the middle, and skipping the second startup's catchup would lose
  // them permanently. The bounded query (perRunLimit, maxAge) and the
  // inbound-dedupe cache from #66230 cap the cost of running the query
  // every startup.

  const earliestAllowed = nowMs - maxAgeMs;
  // A future-dated cursor (clock rollback via NTP correction or manual
  // adjust) is unusable: querying with `after` set to a future timestamp
  // would return zero records, and saving `nowMs` as the new cursor would
  // permanently skip any real messages missed in the
  // [earliestAllowed, nowMs] window. Treat it as if no cursor exists and
  // fall through to the firstRun lookback path; the inbound-dedupe cache
  // from #66230 handles any overlap with already-processed messages, and
  // saving cursor = nowMs at the end of the run repairs the cursor.
  const cursorIsUsable = existing !== null && existing.lastSeenMs <= nowMs;
  // First-run (and recovered-future-cursor) lookback is also clamped to
  // the maxAge ceiling so a config with `maxAgeMinutes: 5,
  // firstRunLookbackMinutes: 30` doesn't silently exceed the operator's
  // stated lookback cap on first startup.
  const windowStartMs = cursorIsUsable
    ? Math.max(existing.lastSeenMs, earliestAllowed)
    : Math.max(nowMs - firstRunLookbackMs, earliestAllowed);

  let baseUrl: string;
  let password: string;
  let allowPrivateNetwork = false;
  try {
    ({ baseUrl, password, allowPrivateNetwork } = resolveBlueBubblesServerAccount({
      serverUrl: target.account.baseUrl,
      password: target.account.config.password,
      accountId,
      cfg: target.config,
    }));
  } catch (err) {
    error?.(`[${accountId}] BlueBubbles catchup: cannot resolve server account: ${String(err)}`);
    return null;
  }

  // Ensure legacy→hashed dedupe file migration runs and the on-disk store
  // is warm before we replay. Without this, an upgrade from a version that
  // used the old `${safe}.json` naming to the current `${safe}__${hash}.json`
  // would start with an empty dedupe cache and re-dispatch every message in
  // the catchup window — producing duplicate replies.
  await warmupBlueBubblesInboundDedupe(accountId).catch((err) => {
    error?.(`[${accountId}] BlueBubbles catchup: dedupe warmup failed: ${String(err)}`);
  });

  const { resolved, messages } = await fetchFn(windowStartMs, perRunLimit, {
    baseUrl,
    password,
    allowPrivateNetwork,
  });

  const summary: BlueBubblesCatchupSummary = {
    querySucceeded: resolved,
    replayed: 0,
    skippedFromMe: 0,
    skippedPreCursor: 0,
    skippedGivenUp: 0,
    failed: 0,
    givenUp: 0,
    cursorBefore,
    cursorAfter: nowMs,
    windowStartMs,
    windowEndMs: nowMs,
    fetchedCount: messages.length,
  };

  if (!resolved) {
    // Leave cursor unchanged so the next run retries the same window.
    error?.(`[${accountId}] BlueBubbles catchup: message-query failed; cursor unchanged`);
    return summary;
  }

  // Track the earliest timestamp where `processMessage` threw *and* the
  // failing message has not yet crossed the per-GUID retry ceiling, so we
  // never advance the cursor past a retryable failure. Normalize failures
  // (the record didn't yield a usable NormalizedWebhookMessage) are
  // treated as permanent skips and do NOT block cursor advance — those
  // payloads are unlikely to ever normalize on retry, and blocking on
  // them would wedge catchup forever. Given-up messages (count >= max)
  // also do NOT contribute here; see `skippedGivenUp` below.
  let earliestProcessFailureTs: number | null = null;
  // Track the latest fetched message timestamp regardless of fate, so a
  // truncated query (fetchedCount === perRunLimit) can advance the cursor
  // exactly to the page boundary. Without this, the unfetched tail past
  // the cap is permanently unreachable.
  let latestFetchedTs = windowStartMs;
  // Next-run retry map. Built from scratch each run so entries for GUIDs
  // that didn't appear in this fetch are dropped (the cursor has
  // advanced past them and they will never be queried again). Entries we
  // do carry forward encode two states via the stored count:
  // - `1 <= count < maxFailureRetries`: still-retrying, holds cursor.
  // - `count >= maxFailureRetries`: given-up, skipped on sight without
  //   another `processMessage` attempt. Preserving the count is what
  //   keeps the give-up state sticky across runs when an earlier
  //   still-retrying failure is holding the cursor and the given-up
  //   message keeps reappearing in the query window.
  const nextRetries: Record<string, number> = {};

  for (const rec of messages) {
    // Defense in depth: the server-side `after:` filter should already
    // exclude pre-cursor messages, but guard here against BB API variants
    // that return inclusive-of-boundary data.
    const ts = typeof rec.dateCreated === "number" ? rec.dateCreated : 0;
    if (ts > 0 && ts > latestFetchedTs) {
      latestFetchedTs = ts;
    }
    if (ts > 0 && ts <= windowStartMs) {
      summary.skippedPreCursor++;
      continue;
    }

    // Filter fromMe early so BB's record of our own outbound sends cannot
    // enter the inbound pipeline even if normalization would accept them.
    if (rec.isFromMe === true || rec.is_from_me === true) {
      summary.skippedFromMe++;
      continue;
    }

    // Skip tapback/reaction/balloon events. These carry an
    // `associatedMessageGuid` pointing at the parent text message and
    // have a different `guid` of their own. The live webhook path handles
    // balloons via the debouncer, which coalesces them with their parent.
    // Without debouncing here, replaying a balloon would dispatch it as a
    // standalone message — producing a duplicate reply to the parent.
    //
    // Guard: only skip when `associatedMessageType` is set (tapbacks and
    // reactions — e.g., "like", 2000) OR `balloonBundleId` is set (URL
    // previews, stickers). iMessage threaded replies use a separate
    // `threadOriginatorGuid` field and do NOT set either of these, so
    // they pass through for correct catchup replay.
    const assocGuid =
      typeof rec.associatedMessageGuid === "string"
        ? rec.associatedMessageGuid.trim()
        : typeof rec.associated_message_guid === "string"
          ? rec.associated_message_guid.trim()
          : "";
    const assocType = rec.associatedMessageType ?? rec.associated_message_type;
    const balloonId = typeof rec.balloonBundleId === "string" ? rec.balloonBundleId.trim() : "";
    if (assocGuid && (assocType != null || balloonId)) {
      continue;
    }

    const normalized = normalizeWebhookMessage({ type: "new-message", data: rec });
    if (!normalized) {
      summary.failed++;
      continue;
    }
    if (normalized.fromMe) {
      summary.skippedFromMe++;
      continue;
    }

    // Prefer the normalized messageId (what the dedupe cache uses) so the
    // retry counter and downstream dedupe key agree on identity. Fall
    // back to the raw BB `guid` only when normalization didn't supply one.
    const retryKey = normalized.messageId ?? (typeof rec.guid === "string" ? rec.guid : "");

    // Already-given-up GUIDs are skipped without another `processMessage`
    // attempt. This is what lets catchup make forward progress through an
    // earlier, still-retrying failure while not burning cycles re-running
    // a permanently broken message every sweep.
    const prevCount = retryKey ? (prevRetries[retryKey] ?? 0) : 0;
    if (retryKey && prevCount >= maxFailureRetries) {
      summary.skippedGivenUp++;
      // Preserve the count so give-up stickiness survives this run.
      nextRetries[retryKey] = prevCount;
      continue;
    }

    try {
      await procFn(normalized, target);
      summary.replayed++;
      // Success clears any accumulated retries for this GUID. Since we
      // build `nextRetries` from scratch rather than mutating
      // `prevRetries`, simply NOT copying the entry is the clear. (We
      // still need this branch so readers understand the lifecycle.)
    } catch (err) {
      summary.failed++;
      const nextCount = prevCount + 1;
      if (retryKey && nextCount >= maxFailureRetries) {
        // Crossing the ceiling this run: log WARN once and record the
        // give-up in the persisted map. Don't contribute to
        // `earliestProcessFailureTs` — we're intentionally letting the
        // cursor advance past this GUID on the next sweep.
        summary.givenUp++;
        nextRetries[retryKey] = nextCount;
        error?.(
          `[${accountId}] BlueBubbles catchup: giving up on guid=${retryKey} ` +
            `after ${nextCount} consecutive failures; future sweeps will skip ` +
            `this message. timestamp=${ts}: ${String(err)}`,
        );
      } else {
        // Still retrying: count this failure and hold the cursor so the
        // next sweep retries the same window. (retryKey may be empty in
        // the unusual case where neither normalizer nor raw payload
        // carried a GUID — in that case we hold the cursor but cannot
        // increment a counter, matching pre-retry-cap behavior.)
        if (retryKey) {
          nextRetries[retryKey] = nextCount;
        }
        if (ts > 0 && (earliestProcessFailureTs === null || ts < earliestProcessFailureTs)) {
          earliestProcessFailureTs = ts;
        }
        error?.(
          `[${accountId}] BlueBubbles catchup: processMessage failed (retry ` +
            `${nextCount}/${maxFailureRetries}): ${String(err)}`,
        );
      }
    }
  }

  // Compute the new cursor.
  //
  // - Default: advance to `nowMs` so subsequent runs start from the moment
  //   this sweep finished (avoiding stuck rescans of a message with
  //   `dateCreated > nowMs` from minor clock skew between BB host and
  //   gateway host).
  // - On retryable failure (any still-retrying `processMessage` throw,
  //   where the GUID has NOT crossed `maxFailureRetries`): hold the
  //   cursor just before the earliest still-retrying failed timestamp so
  //   the next run retries from there. The inbound-dedupe cache from
  //   #66230 keeps successfully replayed messages from being re-processed.
  // - On give-up (failures that crossed `maxFailureRetries`): the GUID
  //   is recorded in the persisted retry map with `count >= max` and
  //   skipped on sight in subsequent runs (without another processMessage
  //   attempt). Give-up GUIDs intentionally do NOT hold the cursor, so
  //   the cursor can advance past them naturally — this is what unwedges
  //   catchup from a permanently malformed message (issue #66870).
  // - On truncation (fetched === perRunLimit): advance only to the latest
  //   fetched timestamp so the next run picks up from the page boundary.
  //   Otherwise the unfetched tail past the cap (which can be substantial
  //   during long outages) would be permanently unreachable.
  const isTruncated = summary.fetchedCount >= perRunLimit;
  let nextCursorMs = nowMs;
  if (earliestProcessFailureTs !== null) {
    const heldCursor = Math.max(earliestProcessFailureTs - 1, cursorBefore ?? windowStartMs);
    nextCursorMs = Math.min(heldCursor, nowMs);
  } else if (isTruncated) {
    // Use latestFetchedTs (clamped to >= prior cursor and <= nowMs) so the
    // next run starts where this page ended.
    nextCursorMs = Math.min(Math.max(latestFetchedTs, cursorBefore ?? windowStartMs), nowMs);
  }
  summary.cursorAfter = nextCursorMs;
  // Cap the retry map before writing — defense in depth against a storm
  // of unique failing GUIDs ballooning the cursor file.
  const retriesToPersist = capFailureRetriesMap(nextRetries, MAX_FAILURE_RETRY_MAP_SIZE);
  await saveBlueBubblesCatchupCursor(accountId, nextCursorMs, retriesToPersist).catch((err) => {
    error?.(`[${accountId}] BlueBubbles catchup: cursor save failed: ${String(err)}`);
  });

  log?.(
    `[${accountId}] BlueBubbles catchup: replayed=${summary.replayed} ` +
      `skipped_fromMe=${summary.skippedFromMe} skipped_preCursor=${summary.skippedPreCursor} ` +
      `skipped_givenUp=${summary.skippedGivenUp} failed=${summary.failed} ` +
      `given_up=${summary.givenUp} fetched=${summary.fetchedCount} ` +
      `window_ms=${nowMs - windowStartMs}`,
  );

  // Distinct WARNING when the BB result hits perRunLimit so operators
  // know a single startup didn't drain the full backlog. The cursor was
  // advanced only to the page boundary above, so the unfetched tail will
  // be picked up on the next gateway startup — but if startups are
  // infrequent, raising perRunLimit drains larger backlogs in one pass.
  if (isTruncated) {
    error?.(
      `[${accountId}] BlueBubbles catchup: WARNING fetched=${summary.fetchedCount} ` +
        `hit perRunLimit=${perRunLimit}; cursor advanced only to page boundary, ` +
        `remaining messages will be picked up on next startup. Raise ` +
        `channels.bluebubbles...catchup.perRunLimit to drain larger backlogs ` +
        `in a single pass.`,
    );
  }

  return summary;
}
