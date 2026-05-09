import { warn } from "openclaw/plugin-sdk/runtime-env";
import type { IMessageRpcClient } from "../client.js";
import {
  type CatchupDispatchFn,
  type CatchupFetchFn,
  type IMessageCatchupRow,
  type IMessageCatchupSummary,
  performIMessageCatchup,
  type ResolvedCatchupConfig,
} from "./catchup.js";
import { parseIMessageNotification } from "./parse-notification.js";
import type { IMessagePayload } from "./types.js";

// Per-chat history fetch budget. messages.history is per-chat; we cap each
// chat's fetch to the global perRunLimit so a single noisy group cannot
// dominate the cursor advance — the cross-chat sort + final slice still
// caps the global pass at perRunLimit.
const PER_CHAT_HISTORY_LIMIT_CAP = 500;

// chats.list page size used during catchup. 200 covers far more than any
// realistic offline window worth of distinct chats while staying well under
// any sensible chat.db query cost.
const CATCHUP_CHATS_LIST_LIMIT = 200;

// Per-RPC timeout. Catchup runs once at startup; a slow imsg should not
// stall the live dispatch loop indefinitely.
const CATCHUP_RPC_TIMEOUT_MS = 30_000;

type ChatsListEntry = {
  id?: number | null;
  last_message_at?: string | null;
};

type MessagesHistoryResult = {
  messages?: unknown[];
};

type RuntimeLogger = {
  log?: (msg: string) => void;
  error?: (msg: string) => void;
};

export type RunIMessageCatchupParams = {
  client: IMessageRpcClient;
  accountId: string;
  config: ResolvedCatchupConfig;
  includeAttachments: boolean;
  /**
   * The same per-message handler the live `imsg watch` notification path
   * runs (i.e. the post-debounce `handleMessageNow` in `monitor-provider`).
   * Catchup feeds rows in oldest-first by rowid. Throws are recorded as
   * dispatch failures; non-throw returns count as successful dispatch
   * (including non-error drops, which mirrors the live pipeline).
   */
  dispatchPayload: (message: IMessagePayload) => Promise<void>;
  runtime?: RuntimeLogger;
  /** Override clock for tests. */
  now?: () => number;
};

/**
 * Wire `performIMessageCatchup` against the live `imsg` JSON-RPC client.
 *
 * Catchup recovers messages that landed in `chat.db` while the gateway was
 * offline (crash, restart, mac sleep) by:
 *   1. listing recently-active chats via `chats.list`,
 *   2. fetching per-chat history since the cursor via `messages.history`,
 *   3. sorting cross-chat by `rowid`, capping at `perRunLimit`,
 *   4. replaying each row through the same `dispatchPayload` handler used
 *      by the live notification loop, so existing dedupe / coalesce / echo
 *      / read-receipt behavior covers replayed rows for free.
 *
 * Runs at most once per `monitorIMessageProvider` invocation, between
 * `watch.subscribe` and the live dispatch loop. Anything that arrives during
 * catchup itself flows through live dispatch; the existing inbound-dedupe
 * cache absorbs any overlap.
 */
export async function runIMessageCatchup(
  params: RunIMessageCatchupParams,
): Promise<IMessageCatchupSummary> {
  const { client, accountId, config, includeAttachments, dispatchPayload, runtime } = params;
  const log = (msg: string) => runtime?.log?.(msg);
  const warnLog = (msg: string) => runtime?.log?.(warn(msg));

  // Map keyed by guid so the dispatch adapter can recover the full payload
  // the fetcher pulled from `messages.history`. Local to this catchup pass —
  // discarded when the function returns.
  const payloadByGuid = new Map<string, IMessagePayload>();

  const fetchFn: CatchupFetchFn = async ({ sinceMs, sinceRowid, limit }) => {
    let chatsResult: { chats?: ChatsListEntry[] } | undefined;
    try {
      chatsResult = await client.request<{ chats?: ChatsListEntry[] }>(
        "chats.list",
        { limit: CATCHUP_CHATS_LIST_LIMIT },
        { timeoutMs: CATCHUP_RPC_TIMEOUT_MS },
      );
    } catch (err) {
      warnLog(`imessage catchup: chats.list failed: ${String(err)}`);
      return { resolved: false, rows: [] };
    }
    const chats = chatsResult?.chats ?? [];
    const sinceISO = new Date(sinceMs).toISOString();
    const collected: IMessageCatchupRow[] = [];
    const perChatLimit = Math.min(limit, PER_CHAT_HISTORY_LIMIT_CAP);
    // Track the highest rowid / date the imsg bridge actually returned across
    // all chats, regardless of whether each row passed the parser. The catchup
    // loop uses this as a cursor-advance floor so an unparseable row (corrupt
    // text column, schema drift, etc.) cannot stall catchup forever — without
    // this, the same broken row would be re-fetched and re-dropped on every
    // gateway startup.
    let rawWatermarkRowid = -Infinity;
    let rawWatermarkMs = -Infinity;

    for (const chat of chats) {
      const chatId = typeof chat.id === "number" && Number.isFinite(chat.id) ? chat.id : null;
      if (chatId === null) {
        continue;
      }
      // Skip chats that have not seen activity in the catchup window. Saves
      // a per-chat RPC for every old archived conversation.
      const lastMs =
        typeof chat.last_message_at === "string" ? Date.parse(chat.last_message_at) : Number.NaN;
      if (Number.isFinite(lastMs) && lastMs < sinceMs) {
        continue;
      }

      let historyResult: MessagesHistoryResult | undefined;
      try {
        historyResult = await client.request<MessagesHistoryResult>(
          "messages.history",
          {
            chat_id: chatId,
            limit: perChatLimit,
            start: sinceISO,
            attachments: includeAttachments,
          },
          { timeoutMs: CATCHUP_RPC_TIMEOUT_MS },
        );
      } catch (err) {
        // Best-effort per chat. A single broken chat must not poison the
        // whole pass — drop and continue.
        warnLog(`imessage catchup: messages.history failed for chat_id=${chatId}: ${String(err)}`);
        continue;
      }

      const messages = Array.isArray(historyResult?.messages) ? historyResult.messages : [];
      for (const raw of messages) {
        // Best-effort raw-watermark probe BEFORE we run the parser, so even
        // rows we drop still let the cursor advance past them. We only trust
        // numeric `id` / parseable `created_at` — if the row is so malformed
        // that we cannot even read those, leave the watermark unchanged for
        // this row (same forward-progress behavior as today, just no worse).
        const rawRecord = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
        const rawRowid =
          rawRecord && typeof rawRecord.id === "number" && Number.isFinite(rawRecord.id)
            ? rawRecord.id
            : null;
        const rawCreatedAt =
          rawRecord && typeof rawRecord.created_at === "string" ? rawRecord.created_at : null;
        const rawDateMs = rawCreatedAt ? Date.parse(rawCreatedAt) : Number.NaN;
        if (rawRowid !== null) {
          rawWatermarkRowid = Math.max(rawWatermarkRowid, rawRowid);
        }
        if (Number.isFinite(rawDateMs)) {
          rawWatermarkMs = Math.max(rawWatermarkMs, rawDateMs);
        }

        // Reuse the live notification parser by wrapping the row in the same
        // `{ message: ... }` envelope. Anything that fails the parser would
        // also be dropped on the live path, so the same shape guard applies.
        const payload = parseIMessageNotification({ message: raw });
        if (!payload) {
          continue;
        }
        const guid = payload.guid?.trim();
        const rowid = typeof payload.id === "number" ? payload.id : null;
        const dateMs =
          typeof payload.created_at === "string" ? Date.parse(payload.created_at) : Number.NaN;
        if (!guid || rowid === null || !Number.isFinite(rowid) || !Number.isFinite(dateMs)) {
          continue;
        }
        if (rowid <= sinceRowid) {
          continue;
        }
        collected.push({
          guid,
          rowid,
          date: dateMs,
          isFromMe: payload.is_from_me === true,
        });
        payloadByGuid.set(guid, payload);
      }
    }

    const sorted = collected.toSorted((a, b) => a.rowid - b.rowid);
    const capped = sorted.slice(0, limit);
    const isCapTruncated = capped.length < sorted.length;
    if (isCapTruncated) {
      warnLog(
        `imessage catchup: fetched ${sorted.length} rows across chats, ` +
          `capped to perRunLimit=${limit} (oldest first); next startup picks up the rest`,
      );
      // Drop payloads we are no longer going to dispatch so the dispatch
      // adapter does not have to defend against the discarded ones.
      const keep = new Set(capped.map((row) => row.guid));
      for (const guid of payloadByGuid.keys()) {
        if (!keep.has(guid)) {
          payloadByGuid.delete(guid);
        }
      }
    }

    // Clamp the raw watermark when cap-truncation hits so the catchup loop
    // cannot persist a cursor past undispatched valid rows. Without this,
    // a `messages.history` page wider than `perRunLimit` would silently
    // skip the cap-truncated tail forever — the WARN above promises the
    // next startup picks up the rest, and that promise relies on the
    // cursor staying at the last dispatched rowid. When no truncation
    // happens, the watermark covers parse-rejected rows interspersed
    // with the dispatched batch (the original forward-progress fix).
    let effectiveWatermarkRowid = rawWatermarkRowid;
    let effectiveWatermarkMs = rawWatermarkMs;
    if (isCapTruncated && capped.length > 0) {
      const last = capped.at(-1);
      if (last) {
        effectiveWatermarkRowid = Math.min(effectiveWatermarkRowid, last.rowid);
        effectiveWatermarkMs = Math.min(effectiveWatermarkMs, last.date);
      }
    } else if (isCapTruncated && capped.length === 0) {
      // Pathological: cap=0. Don't emit any watermark; preserve the prior
      // cursor and let the next pass try again.
      effectiveWatermarkRowid = Number.NaN;
      effectiveWatermarkMs = Number.NaN;
    }

    return {
      resolved: true,
      rows: capped,
      ...(Number.isFinite(effectiveWatermarkRowid)
        ? { highWatermarkRowid: effectiveWatermarkRowid }
        : {}),
      ...(Number.isFinite(effectiveWatermarkMs) ? { highWatermarkMs: effectiveWatermarkMs } : {}),
    };
  };

  const dispatchFn: CatchupDispatchFn = async (row) => {
    const payload = payloadByGuid.get(row.guid);
    if (!payload) {
      // Should not happen: the fetcher only emits rows it has stashed. But
      // if a future caller wires a different fetcher and forgets to populate
      // the map, we would otherwise silently no-op. Treat as a transient
      // failure so the cursor stays put and operators see the warning.
      warnLog(`imessage catchup: missing payload for guid=${row.guid}, skipping`);
      return { ok: false };
    }
    try {
      await dispatchPayload(payload);
      return { ok: true };
    } catch (err) {
      warnLog(`imessage catchup: dispatch threw for guid=${row.guid}: ${String(err)}`);
      return { ok: false };
    }
  };

  return await performIMessageCatchup({
    accountId,
    config,
    fetch: fetchFn,
    dispatch: dispatchFn,
    log,
    warn: warnLog,
    ...(params.now ? { now: params.now() } : {}),
  });
}
