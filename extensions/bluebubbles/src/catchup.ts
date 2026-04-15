import { createHash } from "node:crypto";
import path from "node:path";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { resolveBlueBubblesServerAccount } from "./account-resolve.js";
import { asRecord, normalizeWebhookMessage } from "./monitor-normalize.js";
import { processMessage } from "./monitor-processing.js";
import type { WebhookTarget } from "./monitor-shared.js";
import { blueBubblesFetchWithTimeout, buildBlueBubblesApiUrl } from "./types.js";

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
const FETCH_TIMEOUT_MS = 15_000;

export type BlueBubblesCatchupConfig = {
  enabled?: boolean;
  maxAgeMinutes?: number;
  perRunLimit?: number;
  firstRunLookbackMinutes?: number;
};

export type BlueBubblesCatchupSummary = {
  querySucceeded: boolean;
  replayed: number;
  skippedFromMe: number;
  skippedPreCursor: number;
  failed: number;
  cursorBefore: number | null;
  cursorAfter: number;
  windowStartMs: number;
  windowEndMs: number;
  fetchedCount: number;
};

export type BlueBubblesCatchupCursor = { lastSeenMs: number; updatedAt: number };

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
  return value;
}

export async function saveBlueBubblesCatchupCursor(
  accountId: string,
  lastSeenMs: number,
): Promise<void> {
  const filePath = resolveCursorFilePath(accountId);
  const cursor: BlueBubblesCatchupCursor = { lastSeenMs, updatedAt: Date.now() };
  await writeJsonFileAtomically(filePath, cursor);
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
  const ssrfPolicy = opts.allowPrivateNetwork ? { allowPrivateNetwork: true } : {};
  const url = buildBlueBubblesApiUrl({
    baseUrl: opts.baseUrl,
    path: "/api/v1/message/query",
    password: opts.password,
  });
  const body = JSON.stringify({
    limit,
    sort: "ASC",
    after: sinceMs,
    // `with` mirrors what bb-catchup.sh uses and what the normal webhook
    // payload carries, so normalizeWebhookMessage has the same fields to
    // read during replay as it does on live dispatch.
    with: ["chat", "chat.participants", "attachment"],
  });
  try {
    const res = await blueBubblesFetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
      opts.timeoutMs ?? FETCH_TIMEOUT_MS,
      ssrfPolicy,
    );
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
  return {
    maxAgeMs: maxAgeMinutes * 60_000,
    perRunLimit,
    firstRunLookbackMs: firstRunLookbackMinutes * 60_000,
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

  const { maxAgeMs, perRunLimit, firstRunLookbackMs } = clampCatchupConfig(raw);
  const nowMs = now();
  const existing = await loadBlueBubblesCatchupCursor(accountId).catch(() => null);
  const cursorBefore = existing?.lastSeenMs ?? null;

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
    failed: 0,
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

  // Track the earliest timestamp where `processMessage` threw so we never
  // advance the cursor past a retryable failure. Normalize failures (the
  // record didn't yield a usable NormalizedWebhookMessage) are treated as
  // permanent skips and do NOT block cursor advance — those payloads are
  // unlikely to ever normalize on retry, and blocking on them would wedge
  // catchup forever.
  let earliestProcessFailureTs: number | null = null;
  // Track the latest fetched message timestamp regardless of fate, so a
  // truncated query (fetchedCount === perRunLimit) can advance the cursor
  // exactly to the page boundary. Without this, the unfetched tail past
  // the cap is permanently unreachable.
  let latestFetchedTs = windowStartMs;

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

    const normalized = normalizeWebhookMessage({ type: "new-message", data: rec });
    if (!normalized) {
      summary.failed++;
      continue;
    }
    if (normalized.fromMe) {
      summary.skippedFromMe++;
      continue;
    }

    try {
      await procFn(normalized, target);
      summary.replayed++;
    } catch (err) {
      summary.failed++;
      if (ts > 0 && (earliestProcessFailureTs === null || ts < earliestProcessFailureTs)) {
        earliestProcessFailureTs = ts;
      }
      error?.(`[${accountId}] BlueBubbles catchup: processMessage failed: ${String(err)}`);
    }
  }

  // Compute the new cursor.
  //
  // - Default: advance to `nowMs` so subsequent runs start from the moment
  //   this sweep finished (avoiding stuck rescans of a message with
  //   `dateCreated > nowMs` from minor clock skew between BB host and
  //   gateway host).
  // - On retryable failure (any `processMessage` throw): hold the cursor
  //   just before the earliest failed timestamp so the next run retries
  //   from there. The inbound-dedupe cache from #66230 keeps successfully
  //   replayed messages from being re-processed.
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
  await saveBlueBubblesCatchupCursor(accountId, nextCursorMs).catch((err) => {
    error?.(`[${accountId}] BlueBubbles catchup: cursor save failed: ${String(err)}`);
  });

  log?.(
    `[${accountId}] BlueBubbles catchup: replayed=${summary.replayed} ` +
      `skipped_fromMe=${summary.skippedFromMe} skipped_preCursor=${summary.skippedPreCursor} ` +
      `failed=${summary.failed} fetched=${summary.fetchedCount} ` +
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
