// Imessage tests cover catchup plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getIMessageRuntime } from "../runtime.js";
import { installIMessageStateRuntimeForTest } from "../test-support/runtime.js";
import {
  advanceIMessageCatchupCursor,
  capFailureRetriesMap,
  IMESSAGE_CATCHUP_CURSOR_MAX_ENTRIES,
  IMESSAGE_CATCHUP_CURSOR_NAMESPACE,
  performIMessageCatchup,
  resolveCatchupConfig,
  resolveIMessageCatchupCursorKey,
  type CatchupDispatchFn,
  type CatchupFetchFn,
  type IMessageCatchupCursor,
  type IMessageCatchupRow,
} from "./catchup.js";

function openCatchupCursorStore() {
  return getIMessageRuntime().state.openSyncKeyedStore<IMessageCatchupCursor>({
    namespace: IMESSAGE_CATCHUP_CURSOR_NAMESPACE,
    maxEntries: IMESSAGE_CATCHUP_CURSOR_MAX_ENTRIES,
  });
}

async function loadIMessageCatchupCursor(accountId: string): Promise<IMessageCatchupCursor | null> {
  return openCatchupCursorStore().lookup(resolveIMessageCatchupCursorKey(accountId)) ?? null;
}

async function saveIMessageCatchupCursor(
  accountId: string,
  cursor: Omit<IMessageCatchupCursor, "updatedAt">,
): Promise<void> {
  openCatchupCursorStore().register(resolveIMessageCatchupCursorKey(accountId), {
    ...cursor,
    updatedAt: Date.now(),
  });
}

describe("resolveCatchupConfig", () => {
  beforeEach(() => {
    installIMessageStateRuntimeForTest();
  });

  it("falls back to defaults when raw is undefined", () => {
    const cfg = resolveCatchupConfig(undefined);
    expect(cfg.enabled).toBe(false);
    expect(cfg.maxAgeMinutes).toBe(120);
    expect(cfg.perRunLimit).toBe(50);
    expect(cfg.firstRunLookbackMinutes).toBe(30);
    expect(cfg.maxFailureRetries).toBe(10);
  });

  it("clamps over-limit input to the documented ceiling", () => {
    const cfg = resolveCatchupConfig({
      enabled: true,
      maxAgeMinutes: 99_999,
      perRunLimit: 10_000,
      maxFailureRetries: 50_000,
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.maxAgeMinutes).toBe(720);
    expect(cfg.perRunLimit).toBe(500);
    expect(cfg.maxFailureRetries).toBe(1000);
  });

  it("clamps zero / negative input to 1", () => {
    const cfg = resolveCatchupConfig({
      maxAgeMinutes: 0,
      perRunLimit: -10,
      firstRunLookbackMinutes: -1,
      maxFailureRetries: 0,
    });
    expect(cfg.maxAgeMinutes).toBe(1);
    expect(cfg.perRunLimit).toBe(1);
    expect(cfg.firstRunLookbackMinutes).toBe(1);
    expect(cfg.maxFailureRetries).toBe(1);
  });
});

describe("advanceIMessageCatchupCursor", () => {
  beforeEach(() => {
    installIMessageStateRuntimeForTest();
  });

  it("advances monotonically from a live-handled row and preserves given-up retry state", async () => {
    const config = resolveCatchupConfig({ enabled: true, maxFailureRetries: 3 });
    await saveIMessageCatchupCursor("primary", {
      lastSeenMs: 1_700_000_000_000,
      lastSeenRowid: 42,
      failureRetries: { "GIVEN-UP": 3 },
    });

    await expect(
      advanceIMessageCatchupCursor(
        "primary",
        { lastSeenMs: 1_700_000_001_000, lastSeenRowid: 41 },
        config,
      ),
    ).resolves.toBe(false);
    await expect(
      advanceIMessageCatchupCursor(
        "primary",
        { lastSeenMs: 1_700_000_002_000, lastSeenRowid: 50 },
        config,
      ),
    ).resolves.toBe(true);

    const cursor = await loadIMessageCatchupCursor("primary");
    expect(cursor?.lastSeenRowid).toBe(50);
    expect(cursor?.lastSeenMs).toBe(1_700_000_002_000);
    expect(cursor?.failureRetries).toEqual({ "GIVEN-UP": 3 });
  });

  it("serializes concurrent live cursor advances so a lower row cannot overwrite a higher row", async () => {
    const config = resolveCatchupConfig({ enabled: true, maxFailureRetries: 3 });
    await saveIMessageCatchupCursor("primary", {
      lastSeenMs: 1_700_000_000_000,
      lastSeenRowid: 10,
    });

    const results = await Promise.all([
      advanceIMessageCatchupCursor(
        "primary",
        { lastSeenMs: 1_700_000_050_000, lastSeenRowid: 50 },
        config,
      ),
      ...Array.from({ length: 24 }, (_, index) =>
        advanceIMessageCatchupCursor(
          "primary",
          { lastSeenMs: 1_700_000_011_000 + index, lastSeenRowid: 11 + index },
          config,
        ),
      ),
    ]);

    expect(results[0]).toBe(true);
    expect(results.slice(1).every((advanced) => !advanced)).toBe(true);
    const cursor = await loadIMessageCatchupCursor("primary");
    expect(cursor?.lastSeenRowid).toBe(50);
    expect(cursor?.lastSeenMs).toBe(1_700_000_050_000);
  });

  it("does not advance from live rows while a catchup failure is still retrying", async () => {
    const config = resolveCatchupConfig({ enabled: true, maxFailureRetries: 3 });
    await saveIMessageCatchupCursor("primary", {
      lastSeenMs: 1_700_000_000_000,
      lastSeenRowid: 42,
      failureRetries: { RETRYING: 1 },
    });

    await expect(
      advanceIMessageCatchupCursor(
        "primary",
        { lastSeenMs: 1_700_000_002_000, lastSeenRowid: 50 },
        config,
      ),
    ).resolves.toBe(false);

    const cursor = await loadIMessageCatchupCursor("primary");
    expect(cursor?.lastSeenRowid).toBe(42);
    expect(cursor?.failureRetries).toEqual({ RETRYING: 1 });
  });
});

describe("capFailureRetriesMap", () => {
  beforeEach(() => {
    installIMessageStateRuntimeForTest();
  });

  it("is identity below the cap", () => {
    const map = { a: 1, b: 2 };
    expect(capFailureRetriesMap(map, 10)).toEqual({ a: 1, b: 2 });
  });

  it("keeps the highest counts when over the cap", () => {
    const map = { a: 1, b: 9, c: 5, d: 9 };
    const capped = capFailureRetriesMap(map, 2);
    // Both b and d at 9; tiebreak by guid string (alphabetical) → b, d
    expect(Object.keys(capped).toSorted()).toEqual(["b", "d"]);
  });

  it("keeps the persisted retry map under the plugin-state value budget", () => {
    const map = Object.fromEntries(
      Array.from({ length: 800 }, (_, index) => [`GUID-${index}-${"x".repeat(120)}`, index + 1]),
    );

    const capped = capFailureRetriesMap(map);

    expect(Object.keys(capped).length).toBeLessThanOrEqual(512);
    expect(new TextEncoder().encode(JSON.stringify(capped)).byteLength).toBeLessThanOrEqual(48_000);
  });
});

describe("performIMessageCatchup", () => {
  beforeEach(() => {
    installIMessageStateRuntimeForTest();
  });

  const config = resolveCatchupConfig({ enabled: true });
  const now = 1_700_001_000_000; // arbitrary fixed clock

  function row(overrides: Partial<IMessageCatchupRow>): IMessageCatchupRow {
    return {
      guid: "GUID-X",
      rowid: 1,
      date: now - 60_000,
      isFromMe: false,
      ...overrides,
    };
  }

  function fetchOf(rows: IMessageCatchupRow[]): CatchupFetchFn {
    return vi.fn(async () => ({ resolved: true, rows }));
  }

  function alwaysOk(): CatchupDispatchFn {
    return vi.fn(async () => ({ ok: true }));
  }

  it("replays every fresh inbound row through dispatch and advances the cursor", async () => {
    const dispatch = alwaysOk();
    const fetch = fetchOf([
      row({ guid: "A", rowid: 10, date: now - 30_000 }),
      row({ guid: "B", rowid: 11, date: now - 20_000 }),
    ]);

    const summary = await performIMessageCatchup({
      accountId: "primary",
      config,
      now,
      fetch,
      dispatch,
    });

    expect(summary.querySucceeded).toBe(true);
    expect(summary.replayed).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.cursorAfter.lastSeenRowid).toBe(11);
    expect(dispatch).toHaveBeenCalledTimes(2);

    const cursor = await loadIMessageCatchupCursor("primary");
    expect(cursor?.lastSeenRowid).toBe(11);
  });

  it("skips is_from_me rows but still advances the cursor past them", async () => {
    const dispatch = alwaysOk();
    const observeSkippedFromMe = vi.fn();
    const fetch = fetchOf([
      row({ guid: "A", rowid: 10, isFromMe: true }),
      row({ guid: "B", rowid: 11, isFromMe: false }),
    ]);

    const summary = await performIMessageCatchup({
      accountId: "primary",
      config,
      now,
      fetch,
      dispatch,
      observeSkippedFromMe,
    });

    expect(summary.skippedFromMe).toBe(1);
    expect(summary.replayed).toBe(1);
    expect(summary.cursorAfter.lastSeenRowid).toBe(11);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(observeSkippedFromMe).toHaveBeenCalledWith(
      expect.objectContaining({ guid: "A", rowid: 10, isFromMe: true }),
    );
  });

  it("drops rows older than the maxAgeMinutes ceiling and advances past them", async () => {
    const tightConfig = resolveCatchupConfig({ enabled: true, maxAgeMinutes: 1 });
    const dispatch = alwaysOk();
    const fetch = fetchOf([
      row({ guid: "OLD", rowid: 10, date: now - 10 * 60_000 }), // 10 min old, > 1 min ceiling
      row({ guid: "NEW", rowid: 11, date: now - 30_000 }),
    ]);

    const summary = await performIMessageCatchup({
      accountId: "primary",
      config: tightConfig,
      now,
      fetch,
      dispatch,
    });

    expect(summary.skippedPreCursor).toBe(1);
    expect(summary.replayed).toBe(1);
    expect(summary.cursorAfter.lastSeenRowid).toBe(11);
  });

  it("holds the cursor on the failing row while count < maxFailureRetries", async () => {
    const dispatch = vi.fn<CatchupDispatchFn>(async () => ({ ok: false }));
    const fetch = fetchOf([row({ guid: "A", rowid: 10 })]);

    const summary = await performIMessageCatchup({
      accountId: "primary",
      config,
      now,
      fetch,
      dispatch,
    });

    expect(summary.failed).toBe(1);
    expect(summary.givenUp).toBe(0);
    // Cursor clamps to `failed.rowid - 1` (== 9), strictly below the held
    // failure, so the next pass refetches row 10 — and never leapfrogs it.
    expect(summary.cursorAfter.lastSeenRowid).toBe(9);

    const cursor = await loadIMessageCatchupCursor("primary");
    expect(cursor?.failureRetries?.A).toBe(1);
    expect(cursor?.lastSeenRowid).toBe(9);
  });

  it("crosses the maxFailureRetries ceiling, gives up, and advances past the wedged row", async () => {
    const tightConfig = resolveCatchupConfig({ enabled: true, maxFailureRetries: 2 });
    const dispatch = vi.fn<CatchupDispatchFn>(async () => ({ ok: false }));
    const fetch = fetchOf([row({ guid: "A", rowid: 10 })]);

    // First pass: count goes 0 → 1, cursor held below the failed row.
    // The clamp is `failed.rowid - 1` (== 9), not the prior cursor (0), so
    // the next pass refetches row 10 without re-walking older history.
    await performIMessageCatchup({
      accountId: "primary",
      config: tightConfig,
      now,
      fetch,
      dispatch,
    });
    expect((await loadIMessageCatchupCursor("primary"))?.lastSeenRowid).toBe(9);

    // Second pass: count goes 1 → 2 (== ceiling), give up, cursor advances.
    const fetch2 = fetchOf([row({ guid: "A", rowid: 10 })]);
    const summary = await performIMessageCatchup({
      accountId: "primary",
      config: tightConfig,
      now,
      fetch: fetch2,
      dispatch,
    });

    expect(summary.givenUp).toBe(1);
    expect(summary.cursorAfter.lastSeenRowid).toBe(10);

    const cursor = await loadIMessageCatchupCursor("primary");
    expect(cursor?.failureRetries?.A).toBe(2);
  });

  it("treats already-given-up rows as skippedGivenUp without dispatching", async () => {
    await saveIMessageCatchupCursor("primary", {
      lastSeenMs: now - 60_000,
      lastSeenRowid: 0,
      failureRetries: { "WEDGED-1": 99 },
    });

    const dispatch = alwaysOk();
    const fetch = fetchOf([row({ guid: "WEDGED-1", rowid: 5 }), row({ guid: "FRESH", rowid: 6 })]);

    const summary = await performIMessageCatchup({
      accountId: "primary",
      config,
      now,
      fetch,
      dispatch,
    });

    expect(summary.skippedGivenUp).toBe(1);
    expect(summary.replayed).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("removes a guid from the retry map after a successful dispatch", async () => {
    await saveIMessageCatchupCursor("primary", {
      lastSeenMs: now - 60_000,
      lastSeenRowid: 0,
      failureRetries: { RETRYING: 1 },
    });

    const dispatch = alwaysOk();
    const fetch = fetchOf([row({ guid: "RETRYING", rowid: 5 })]);

    await performIMessageCatchup({
      accountId: "primary",
      config,
      now,
      fetch,
      dispatch,
    });

    const cursor = await loadIMessageCatchupCursor("primary");
    expect(cursor?.failureRetries).toBeUndefined();
  });

  it("does NOT leapfrog a held failure when a later row in the same batch succeeds", async () => {
    // Regression for #78649 cursor-leapfrog bug. Prior to the fix the loop
    // advanced lastSeenRowid on every successful row, so a held failure at
    // rowid 10 followed by a success at rowid 11 would persist the cursor
    // at 11 — and the next pass would filter row 10 out via `row.rowid <=
    // sinceRowid` and never retry it. With the fix in place the cursor is
    // clamped to `earliestHeldFailureRow.rowid - 1` (== 9) so the next pass
    // refetches row 10.
    let dispatchCount = 0;
    const dispatch = vi.fn<CatchupDispatchFn>(async (rowLocal) => {
      dispatchCount += 1;
      if (rowLocal.guid === "A") {
        return { ok: false };
      }
      return { ok: true };
    });
    const fetch = fetchOf([
      row({ guid: "A", rowid: 10, date: now - 40_000 }),
      row({ guid: "B", rowid: 11, date: now - 30_000 }),
    ]);

    const summary = await performIMessageCatchup({
      accountId: "primary",
      config,
      now,
      fetch,
      dispatch,
    });

    expect(summary.failed).toBe(1);
    expect(summary.replayed).toBe(1);
    expect(summary.givenUp).toBe(0);
    // Cursor must not leapfrog the held failure at rowid 10. The persisted
    // cursor lands at rowid 9 so the next pass refetches row 10.
    expect(summary.cursorAfter.lastSeenRowid).toBe(9);
    expect(dispatchCount).toBe(2);

    const cursor = await loadIMessageCatchupCursor("primary");
    expect(cursor?.lastSeenRowid).toBe(9);
    expect(cursor?.failureRetries?.A).toBe(1);
  });

  it("keeps held failure state when a live monitor advances the same cursor mid-pass", async () => {
    const dispatch = vi.fn<CatchupDispatchFn>(async () => {
      await advanceIMessageCatchupCursor(
        "primary",
        { lastSeenMs: now - 10_000, lastSeenRowid: 50 },
        config,
      );
      return { ok: false };
    });
    const fetch = fetchOf([row({ guid: "A", rowid: 10, date: now - 40_000 })]);

    const summary = await performIMessageCatchup({
      accountId: "primary",
      config,
      now,
      fetch,
      dispatch,
    });

    expect(summary.failed).toBe(1);
    expect(summary.cursorAfter.lastSeenRowid).toBe(9);

    const cursor = await loadIMessageCatchupCursor("primary");
    expect(cursor?.lastSeenRowid).toBe(9);
    expect(cursor?.failureRetries?.A).toBe(1);
  });

  it("advances the cursor past parser-rejected rows via the fetch high-watermark", async () => {
    // Regression: without a high-watermark from the fetcher, an unparseable
    // row never reaches the loop, so the cursor never advances past it and
    // the next pass re-fetches and re-drops the same broken row forever.
    // The bridge probes raw `id` / `created_at` per row and emits a
    // `highWatermarkRowid` / `highWatermarkMs` floor so the loop can advance
    // the cursor even when every fetched row fails the payload parser.
    const dispatch = vi.fn<CatchupDispatchFn>(async () => ({ ok: true }));
    const fetch: CatchupFetchFn = vi.fn(async () => ({
      resolved: true,
      rows: [],
      highWatermarkRowid: 42,
      highWatermarkMs: now - 5_000,
    }));

    const summary = await performIMessageCatchup({
      accountId: "primary",
      config,
      now,
      fetch,
      dispatch,
    });

    expect(summary.querySucceeded).toBe(true);
    expect(summary.replayed).toBe(0);
    expect(summary.fetchedCount).toBe(0);
    expect(summary.cursorAfter.lastSeenRowid).toBe(42);
    expect(dispatch).not.toHaveBeenCalled();

    const cursor = await loadIMessageCatchupCursor("primary");
    expect(cursor?.lastSeenRowid).toBe(42);
    expect(cursor?.lastSeenMs).toBe(now - 5_000);
  });

  it("does not let the high-watermark leapfrog a held failure", async () => {
    // The fetcher's watermark is a floor for cursor advance, but a held
    // failure must still clamp the cursor below the failed row even when
    // the fetcher reports a higher watermark.
    const dispatch = vi.fn<CatchupDispatchFn>(async () => ({ ok: false }));
    const fetch: CatchupFetchFn = vi.fn(async () => ({
      resolved: true,
      rows: [row({ guid: "A", rowid: 10, date: now - 40_000 })],
      highWatermarkRowid: 99,
      highWatermarkMs: now - 100,
    }));

    const summary = await performIMessageCatchup({
      accountId: "primary",
      config,
      now,
      fetch,
      dispatch,
    });

    expect(summary.failed).toBe(1);
    // Even though the fetcher reports watermark=99, the held failure at
    // rowid 10 clamps the cursor at 9.
    expect(summary.cursorAfter.lastSeenRowid).toBe(9);
  });

  it("returns querySucceeded=false and preserves the cursor on fetch failure", async () => {
    await saveIMessageCatchupCursor("primary", { lastSeenMs: now - 60_000, lastSeenRowid: 7 });
    const dispatch = alwaysOk();
    const fetch = vi.fn<CatchupFetchFn>(async () => {
      throw new Error("imsg rpc closed");
    });
    const warn = vi.fn();

    const summary = await performIMessageCatchup({
      accountId: "primary",
      config,
      now,
      fetch,
      dispatch,
      warn,
    });

    expect(summary.querySucceeded).toBe(false);
    expect(summary.replayed).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("imessage catchup: fetch failed: Error: imsg rpc closed");

    const cursor = await loadIMessageCatchupCursor("primary");
    expect(cursor?.lastSeenRowid).toBe(7);
  });
});
