import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchBlueBubblesMessagesSince,
  loadBlueBubblesCatchupCursor,
  runBlueBubblesCatchup,
  saveBlueBubblesCatchupCursor,
} from "./catchup.js";
import type { NormalizedWebhookMessage } from "./monitor-normalize.js";
import type { WebhookTarget } from "./monitor-shared.js";

function makeStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catchup-test-"));
  process.env.OPENCLAW_STATE_DIR = dir;
  return dir;
}

function clearStateDir(dir: string): void {
  delete process.env.OPENCLAW_STATE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeTarget(overrides: Partial<WebhookTarget & { accountId: string }> = {}): WebhookTarget {
  const accountId = overrides.accountId ?? "test-account";
  return {
    account: {
      accountId,
      enabled: true,
      name: accountId,
      configured: true,
      baseUrl: "http://127.0.0.1:1234",
      config: {
        serverUrl: "http://127.0.0.1:1234",
        password: "test-password",
        network: { dangerouslyAllowPrivateNetwork: true },
      } as unknown as WebhookTarget["account"]["config"],
    },
    config: {} as unknown as WebhookTarget["config"],
    runtime: { log: () => {}, error: () => {} },
    core: {} as unknown as WebhookTarget["core"],
    path: "/bluebubbles-webhook",
    ...overrides,
  };
}

function makeBbMessage(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    guid: `guid-${Math.random().toString(36).slice(2, 10)}`,
    text: "hello",
    dateCreated: 2_000,
    handle: { address: "+15555550123" },
    chats: [{ guid: "iMessage;-;+15555550123" }],
    isFromMe: false,
    ...over,
  };
}

describe("catchup cursor persistence", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = makeStateDir();
  });
  afterEach(() => {
    clearStateDir(stateDir);
  });

  it("returns null before the first save", async () => {
    expect(await loadBlueBubblesCatchupCursor("acct")).toBeNull();
  });

  it("round-trips a saved cursor", async () => {
    await saveBlueBubblesCatchupCursor("acct", 1_234_567);
    const loaded = await loadBlueBubblesCatchupCursor("acct");
    expect(loaded?.lastSeenMs).toBe(1_234_567);
    expect(typeof loaded?.updatedAt).toBe("number");
  });

  it("scopes cursor files per account", async () => {
    await saveBlueBubblesCatchupCursor("a", 100);
    await saveBlueBubblesCatchupCursor("b", 200);
    expect((await loadBlueBubblesCatchupCursor("a"))?.lastSeenMs).toBe(100);
    expect((await loadBlueBubblesCatchupCursor("b"))?.lastSeenMs).toBe(200);
  });

  it("treats filesystem-unsafe account IDs as distinct", async () => {
    // Different account IDs that happen to map to the same safePrefix must
    // not collide on disk.
    await saveBlueBubblesCatchupCursor("acct/a", 111);
    await saveBlueBubblesCatchupCursor("acct:a", 222);
    expect((await loadBlueBubblesCatchupCursor("acct/a"))?.lastSeenMs).toBe(111);
    expect((await loadBlueBubblesCatchupCursor("acct:a"))?.lastSeenMs).toBe(222);
  });
});

describe("runBlueBubblesCatchup", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = makeStateDir();
  });
  afterEach(() => {
    clearStateDir(stateDir);
    vi.restoreAllMocks();
  });

  it("coalesces concurrent runs for the same accountId via in-process singleflight", async () => {
    // Two calls firing simultaneously must share one run, one fetch, one
    // set of processMessage calls, one cursor write. Without singleflight,
    // both calls would read the same cursor, both would process the same
    // messages twice (caught by #66816 dedupe, but wasteful), and the
    // second writer could regress the cursor if its nowMs is stale.
    const now = 10 * 60 * 1000;
    await saveBlueBubblesCatchupCursor("test-account", 5 * 60 * 1000);

    let fetchCount = 0;
    let processCount = 0;
    let resolveFetch: (() => void) | null = null;

    const call1 = runBlueBubblesCatchup(makeTarget(), {
      now: () => now,
      fetchMessages: async () => {
        fetchCount++;
        // Block until we fire the second call, so we can verify it
        // coalesces rather than starting a new run.
        await new Promise<void>((resolve) => {
          resolveFetch = resolve;
        });
        return {
          resolved: true,
          messages: [makeBbMessage({ guid: "g1", dateCreated: 6 * 60 * 1000 })],
        };
      },
      processMessageFn: async () => {
        processCount++;
      },
    });

    // Wait a tick for call1 to enter fetchMessages, then fire call2.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    const call2 = runBlueBubblesCatchup(makeTarget(), {
      now: () => now,
      fetchMessages: async () => {
        fetchCount++;
        return { resolved: true, messages: [makeBbMessage({ guid: "g2" })] };
      },
      processMessageFn: async () => {
        processCount++;
      },
    });

    resolveFetch!();
    const [r1, r2] = await Promise.all([call1, call2]);

    expect(fetchCount).toBe(1); // second call coalesced, didn't re-fetch
    expect(processCount).toBe(1);
    expect(r1).toBe(r2); // same summary object returned to both callers
  });

  it("replays messages and advances the cursor on success", async () => {
    const now = 10_000;
    const processed: NormalizedWebhookMessage[] = [];
    const summary = await runBlueBubblesCatchup(makeTarget(), {
      now: () => now,
      fetchMessages: async () => ({
        resolved: true,
        messages: [
          makeBbMessage({ guid: "g1", text: "one", dateCreated: 9_000 }),
          makeBbMessage({ guid: "g2", text: "two", dateCreated: 9_500 }),
        ],
      }),
      processMessageFn: async (message) => {
        processed.push(message);
      },
    });

    expect(summary?.querySucceeded).toBe(true);
    expect(summary?.replayed).toBe(2);
    expect(summary?.failed).toBe(0);
    expect(processed.map((m) => m.messageId)).toEqual(["g1", "g2"]);
    const cursor = await loadBlueBubblesCatchupCursor("test-account");
    expect(cursor?.lastSeenMs).toBe(now);
  });

  it("clamps first-run lookback to maxAgeMinutes when smaller", async () => {
    const now = 1_000_000;
    let seenSince = -1;
    await runBlueBubblesCatchup(
      makeTarget({
        account: {
          accountId: "test-account",
          enabled: true,
          configured: true,
          baseUrl: "http://127.0.0.1:1234",
          config: {
            serverUrl: "http://127.0.0.1:1234",
            password: "x",
            network: { dangerouslyAllowPrivateNetwork: true },
            // maxAge tighter than firstRunLookback — must clamp on first run.
            catchup: { maxAgeMinutes: 5, firstRunLookbackMinutes: 30 },
          } as unknown as WebhookTarget["account"]["config"],
        },
      }),
      {
        now: () => now,
        fetchMessages: async (sinceMs) => {
          seenSince = sinceMs;
          return { resolved: true, messages: [] };
        },
        processMessageFn: async () => {},
      },
    );
    expect(seenSince).toBe(now - 5 * 60_000);
  });

  it("uses firstRunLookback when no cursor exists", async () => {
    const now = 1_000_000;
    let seenSince = 0;
    await runBlueBubblesCatchup(
      makeTarget({
        account: {
          accountId: "test-account",
          enabled: true,
          configured: true,
          baseUrl: "http://127.0.0.1:1234",
          config: {
            serverUrl: "http://127.0.0.1:1234",
            password: "x",
            network: { dangerouslyAllowPrivateNetwork: true },
            catchup: { firstRunLookbackMinutes: 5 },
          } as unknown as WebhookTarget["account"]["config"],
        },
      }),
      {
        now: () => now,
        fetchMessages: async (sinceMs) => {
          seenSince = sinceMs;
          return { resolved: true, messages: [] };
        },
        processMessageFn: async () => {},
      },
    );
    expect(seenSince).toBe(now - 5 * 60_000);
  });

  it("clamps window to maxAgeMinutes when cursor is older", async () => {
    const now = 100 * 60_000;
    await saveBlueBubblesCatchupCursor("test-account", 0);
    let seenSince = -1;
    await runBlueBubblesCatchup(
      makeTarget({
        account: {
          accountId: "test-account",
          enabled: true,
          configured: true,
          baseUrl: "http://127.0.0.1:1234",
          config: {
            serverUrl: "http://127.0.0.1:1234",
            password: "x",
            network: { dangerouslyAllowPrivateNetwork: true },
            catchup: { maxAgeMinutes: 10 },
          } as unknown as WebhookTarget["account"]["config"],
        },
      }),
      {
        now: () => now,
        fetchMessages: async (sinceMs) => {
          seenSince = sinceMs;
          return { resolved: true, messages: [] };
        },
        processMessageFn: async () => {},
      },
    );
    expect(seenSince).toBe(now - 10 * 60_000);
  });

  it("skips when enabled: false", async () => {
    const called = { fetch: 0, proc: 0 };
    const summary = await runBlueBubblesCatchup(
      makeTarget({
        account: {
          accountId: "test-account",
          enabled: true,
          configured: true,
          baseUrl: "http://127.0.0.1:1234",
          config: {
            serverUrl: "http://127.0.0.1:1234",
            password: "x",
            network: { dangerouslyAllowPrivateNetwork: true },
            catchup: { enabled: false },
          } as unknown as WebhookTarget["account"]["config"],
        },
      }),
      {
        now: () => 1_000,
        fetchMessages: async () => {
          called.fetch++;
          return { resolved: true, messages: [] };
        },
        processMessageFn: async () => {
          called.proc++;
        },
      },
    );
    expect(summary).toBeNull();
    expect(called.fetch).toBe(0);
    expect(called.proc).toBe(0);
  });

  it("runs catchup even on rapid restarts (no min-interval gate)", async () => {
    // Catchup runs once per gateway startup, so a quick restart MUST run
    // it again — otherwise messages dropped between the two startups
    // (gateway down → BB ECONNREFUSED → gateway up <30s later) are lost
    // permanently. Bounded by perRunLimit/maxAge + dedupe-protected.
    const now = 10_000;
    await saveBlueBubblesCatchupCursor("test-account", now - 5_000);
    let fetched = false;
    const summary = await runBlueBubblesCatchup(makeTarget(), {
      now: () => now,
      fetchMessages: async () => {
        fetched = true;
        return { resolved: true, messages: [] };
      },
      processMessageFn: async () => {},
    });
    expect(fetched).toBe(true);
    expect(summary).not.toBeNull();
  });

  it("advances cursor only to last fetched ts when result is truncated (perRunLimit hit)", async () => {
    // Long-outage scenario: 4 messages arrived during downtime but
    // perRunLimit=2. Sort:ASC means we get the 2 oldest. Cursor must
    // advance to the 2nd's timestamp (not nowMs) so the next startup
    // picks up the remaining 2.
    const now = 100 * 60 * 1000;
    await saveBlueBubblesCatchupCursor("test-account", 50 * 60 * 1000);
    const summary = await runBlueBubblesCatchup(
      makeTarget({
        account: {
          accountId: "test-account",
          enabled: true,
          configured: true,
          baseUrl: "http://127.0.0.1:1234",
          config: {
            serverUrl: "http://127.0.0.1:1234",
            password: "x",
            network: { dangerouslyAllowPrivateNetwork: true },
            catchup: { perRunLimit: 2 },
          } as unknown as WebhookTarget["account"]["config"],
        },
      }),
      {
        now: () => now,
        fetchMessages: async () => ({
          resolved: true,
          // Only the 2 the cap allows BB to return (oldest first via ASC).
          messages: [
            makeBbMessage({ guid: "p1", dateCreated: 60 * 60 * 1000 }),
            makeBbMessage({ guid: "p2", dateCreated: 70 * 60 * 1000 }),
          ],
        }),
        processMessageFn: async () => {},
      },
    );
    expect(summary?.replayed).toBe(2);
    expect(summary?.fetchedCount).toBe(2);
    expect(summary?.cursorAfter).toBe(70 * 60 * 1000); // page boundary, not nowMs
    const cursor = await loadBlueBubblesCatchupCursor("test-account");
    expect(cursor?.lastSeenMs).toBe(70 * 60 * 1000);
  });

  it("filters isFromMe before dispatch and still advances cursor", async () => {
    const now = 10_000;
    const processed: NormalizedWebhookMessage[] = [];
    const summary = await runBlueBubblesCatchup(makeTarget(), {
      now: () => now,
      fetchMessages: async () => ({
        resolved: true,
        messages: [
          makeBbMessage({ guid: "g-me", text: "self", dateCreated: 9_500, isFromMe: true }),
          makeBbMessage({ guid: "g-them", text: "them", dateCreated: 9_500 }),
        ],
      }),
      processMessageFn: async (m) => {
        processed.push(m);
      },
    });
    expect(summary?.replayed).toBe(1);
    expect(summary?.skippedFromMe).toBe(1);
    expect(processed.map((m) => m.messageId)).toEqual(["g-them"]);
  });

  it("leaves cursor unchanged when the query fails", async () => {
    // Use timestamps well past MIN_INTERVAL_MS (30s) so the rate-limit skip
    // doesn't short-circuit the run before the fetch path fires.
    const now = 10 * 60 * 1000;
    await saveBlueBubblesCatchupCursor("test-account", 5 * 60 * 1000);
    const summary = await runBlueBubblesCatchup(makeTarget(), {
      now: () => now,
      fetchMessages: async () => ({ resolved: false, messages: [] }),
      processMessageFn: async () => {},
    });
    expect(summary?.querySucceeded).toBe(false);
    const cursor = await loadBlueBubblesCatchupCursor("test-account");
    expect(cursor?.lastSeenMs).toBe(5 * 60 * 1000); // unchanged
  });

  it("does NOT advance cursor past a processMessage failure (retryable)", async () => {
    const cursorBefore = 5 * 60 * 1000;
    const now = 10 * 60 * 1000;
    await saveBlueBubblesCatchupCursor("test-account", cursorBefore);
    const summary = await runBlueBubblesCatchup(makeTarget(), {
      now: () => now,
      fetchMessages: async () => ({
        resolved: true,
        messages: [
          makeBbMessage({ guid: "ok1", dateCreated: 6 * 60 * 1000 }),
          makeBbMessage({ guid: "bad", dateCreated: 7 * 60 * 1000 }),
          makeBbMessage({ guid: "ok2", dateCreated: 8 * 60 * 1000 }),
        ],
      }),
      processMessageFn: async (m) => {
        if (m.messageId === "bad") {
          throw new Error("transient");
        }
      },
    });
    // Cursor is held just before the bad message's timestamp so the next
    // sweep retries it (and re-queries ok1 which dedupe will drop).
    expect(summary?.failed).toBe(1);
    expect(summary?.givenUp).toBe(0);
    expect(summary?.cursorAfter).toBe(7 * 60 * 1000 - 1);
    const cursorAfter = await loadBlueBubblesCatchupCursor("test-account");
    expect(cursorAfter?.lastSeenMs).toBe(7 * 60 * 1000 - 1);
    // Retry counter is persisted so subsequent sweeps know how close we
    // are to the give-up ceiling.
    expect(cursorAfter?.failureRetries?.bad).toBe(1);
  });

  it("clamps held cursor to previous cursor when failure ts is below it", async () => {
    // Pathological: failure timestamp is at or below the previous cursor
    // (shouldn't happen with server-side `after:` but defense in depth).
    // We must never regress the cursor.
    const cursorBefore = 9 * 60 * 1000;
    const now = 10 * 60 * 1000;
    await saveBlueBubblesCatchupCursor("test-account", cursorBefore);
    const summary = await runBlueBubblesCatchup(makeTarget(), {
      now: () => now,
      fetchMessages: async () => ({
        resolved: true,
        messages: [makeBbMessage({ guid: "bad", dateCreated: 1_000 })],
      }),
      processMessageFn: async () => {
        throw new Error("transient");
      },
    });
    // skippedPreCursor catches the bad record before processMessage runs,
    // so no failure is recorded and cursor advances to nowMs normally.
    expect(summary?.failed).toBe(0);
    expect(summary?.skippedPreCursor).toBe(1);
    expect(summary?.cursorAfter).toBe(now);
  });

  it("recovers from a future-dated cursor by falling through to firstRunLookback", async () => {
    // Clock-skew scenario: cursor was written with a wall time that is now
    // ahead of the corrected clock. Catchup must NOT pass `after=future`
    // to BB (which would return zero), and must NOT save cursor=nowMs
    // without first replaying the [earliestAllowed, nowMs] window.
    const now = 1_000_000;
    const futureCursor = now + 60_000;
    await saveBlueBubblesCatchupCursor("test-account", futureCursor);
    let seenSince = -1;
    const summary = await runBlueBubblesCatchup(makeTarget(), {
      now: () => now,
      fetchMessages: async (sinceMs) => {
        seenSince = sinceMs;
        return { resolved: true, messages: [] };
      },
      processMessageFn: async () => {},
    });
    // Should fall through to firstRunLookback (default 30 min), clamped
    // to maxAge (default 120 min) — i.e. nowMs - 30min, NOT nowMs.
    expect(seenSince).toBe(now - 30 * 60_000);
    expect(summary).not.toBeNull();
    // Cursor should be repaired to nowMs so subsequent runs are normal.
    const repaired = await loadBlueBubblesCatchupCursor("test-account");
    expect(repaired?.lastSeenMs).toBe(now);
  });

  it("isolates one failing message and keeps processing the rest", async () => {
    const now = 10_000;
    const processed: string[] = [];
    const summary = await runBlueBubblesCatchup(makeTarget(), {
      now: () => now,
      fetchMessages: async () => ({
        resolved: true,
        messages: [
          makeBbMessage({ guid: "ok1", text: "ok1" }),
          makeBbMessage({ guid: "bad", text: "bad" }),
          makeBbMessage({ guid: "ok2", text: "ok2" }),
        ],
      }),
      processMessageFn: async (m) => {
        if (m.messageId === "bad") {
          throw new Error("boom");
        }
        processed.push(m.messageId ?? "?");
      },
    });
    expect(summary?.replayed).toBe(2);
    expect(summary?.failed).toBe(1);
    expect(processed).toEqual(["ok1", "ok2"]);
  });

  it("warns when fetched count hits perRunLimit so silent truncation is visible", async () => {
    const now = 10 * 60 * 1000;
    await saveBlueBubblesCatchupCursor("test-account", 5 * 60 * 1000);
    const warnings: string[] = [];
    const summary = await runBlueBubblesCatchup(
      makeTarget({
        account: {
          accountId: "test-account",
          enabled: true,
          configured: true,
          baseUrl: "http://127.0.0.1:1234",
          config: {
            serverUrl: "http://127.0.0.1:1234",
            password: "x",
            network: { dangerouslyAllowPrivateNetwork: true },
            catchup: { perRunLimit: 3 },
          } as unknown as WebhookTarget["account"]["config"],
        },
      }),
      {
        now: () => now,
        fetchMessages: async () => ({
          resolved: true,
          messages: [
            makeBbMessage({ guid: "a", dateCreated: 6 * 60 * 1000 }),
            makeBbMessage({ guid: "b", dateCreated: 7 * 60 * 1000 }),
            makeBbMessage({ guid: "c", dateCreated: 8 * 60 * 1000 }),
          ],
        }),
        processMessageFn: async () => {},
        error: (msg) => warnings.push(msg),
      },
    );
    expect(summary?.replayed).toBe(3);
    expect(summary?.fetchedCount).toBe(3);
    const truncationWarnings = warnings.filter((w) => w.includes("perRunLimit"));
    expect(truncationWarnings).toHaveLength(1);
    expect(truncationWarnings[0]).toContain("WARNING");
    expect(truncationWarnings[0]).toContain("perRunLimit=3");
  });

  it("does not warn when fetched count is below perRunLimit", async () => {
    const now = 10 * 60 * 1000;
    await saveBlueBubblesCatchupCursor("test-account", 5 * 60 * 1000);
    const warnings: string[] = [];
    await runBlueBubblesCatchup(
      makeTarget({
        account: {
          accountId: "test-account",
          enabled: true,
          configured: true,
          baseUrl: "http://127.0.0.1:1234",
          config: {
            serverUrl: "http://127.0.0.1:1234",
            password: "x",
            network: { dangerouslyAllowPrivateNetwork: true },
            catchup: { perRunLimit: 50 },
          } as unknown as WebhookTarget["account"]["config"],
        },
      }),
      {
        now: () => now,
        fetchMessages: async () => ({
          resolved: true,
          messages: [makeBbMessage({ guid: "a" }), makeBbMessage({ guid: "b" })],
        }),
        processMessageFn: async () => {},
        error: (msg) => warnings.push(msg),
      },
    );
    expect(warnings.filter((w) => w.includes("perRunLimit"))).toHaveLength(0);
  });

  it("skips pre-cursor timestamps as defense in depth against server-inclusive bounds", async () => {
    const cursor = 5 * 60 * 1000;
    const now = 10 * 60 * 1000;
    await saveBlueBubblesCatchupCursor("test-account", cursor);
    const processed: string[] = [];
    const summary = await runBlueBubblesCatchup(makeTarget(), {
      now: () => now,
      fetchMessages: async () => ({
        resolved: true,
        messages: [
          makeBbMessage({ guid: "before", text: "before", dateCreated: cursor - 1_000 }),
          makeBbMessage({ guid: "at-boundary", text: "boundary", dateCreated: cursor }),
          makeBbMessage({ guid: "after", text: "after", dateCreated: cursor + 1_000 }),
        ],
      }),
      processMessageFn: async (m) => {
        processed.push(m.messageId ?? "?");
      },
    });
    expect(summary?.replayed).toBe(1);
    expect(summary?.skippedPreCursor).toBe(2);
    expect(processed).toEqual(["after"]);
  });
});

describe("runBlueBubblesCatchup — per-message retry cap", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = makeStateDir();
  });
  afterEach(() => {
    clearStateDir(stateDir);
    vi.restoreAllMocks();
  });

  it("increments retry counter on each consecutive failure and holds cursor", async () => {
    // Three sweeps, all fail on the same GUID. Counter accumulates and
    // cursor stays pinned below the failing message so every sweep
    // retries it. maxFailureRetries: 5 so we don't give up inside this
    // test.
    const now1 = 10 * 60 * 1000;
    const now2 = now1 + 60 * 1000;
    const now3 = now2 + 60 * 1000;
    await saveBlueBubblesCatchupCursor("test-account", 5 * 60 * 1000);

    const target = makeTarget({
      account: {
        accountId: "test-account",
        enabled: true,
        configured: true,
        baseUrl: "http://127.0.0.1:1234",
        config: {
          serverUrl: "http://127.0.0.1:1234",
          password: "x",
          network: { dangerouslyAllowPrivateNetwork: true },
          catchup: { maxFailureRetries: 5 },
        } as unknown as WebhookTarget["account"]["config"],
      },
    });

    const fetchMessages = async () => ({
      resolved: true,
      messages: [makeBbMessage({ guid: "wedge", dateCreated: 7 * 60 * 1000 })],
    });
    const processMessageFn = async () => {
      throw new Error("boom");
    };

    const s1 = await runBlueBubblesCatchup(target, {
      now: () => now1,
      fetchMessages,
      processMessageFn,
    });
    const s2 = await runBlueBubblesCatchup(target, {
      now: () => now2,
      fetchMessages,
      processMessageFn,
    });
    const s3 = await runBlueBubblesCatchup(target, {
      now: () => now3,
      fetchMessages,
      processMessageFn,
    });

    expect(s1?.failed).toBe(1);
    expect(s1?.givenUp).toBe(0);
    expect(s2?.givenUp).toBe(0);
    expect(s3?.givenUp).toBe(0);
    const cursor = await loadBlueBubblesCatchupCursor("test-account");
    expect(cursor?.failureRetries?.wedge).toBe(3);
    // Cursor still held just below the wedge message's timestamp.
    expect(cursor?.lastSeenMs).toBe(7 * 60 * 1000 - 1);
  });

  it("gives up on the Nth consecutive failure and records count >= max", async () => {
    const now = 10 * 60 * 1000;
    await saveBlueBubblesCatchupCursor("test-account", 5 * 60 * 1000);
    // Pre-seed a cursor with retries at the one-before-give-up threshold
    // so a single run trips the ceiling. This mirrors what would happen
    // after many runs through the incremental-retry path above.
    await saveBlueBubblesCatchupCursor("test-account", 5 * 60 * 1000, { wedge: 2 });

    const warnings: string[] = [];
    const target = makeTarget({
      account: {
        accountId: "test-account",
        enabled: true,
        configured: true,
        baseUrl: "http://127.0.0.1:1234",
        config: {
          serverUrl: "http://127.0.0.1:1234",
          password: "x",
          network: { dangerouslyAllowPrivateNetwork: true },
          catchup: { maxFailureRetries: 3 },
        } as unknown as WebhookTarget["account"]["config"],
      },
    });

    const summary = await runBlueBubblesCatchup(target, {
      now: () => now,
      fetchMessages: async () => ({
        resolved: true,
        messages: [makeBbMessage({ guid: "wedge", dateCreated: 7 * 60 * 1000 })],
      }),
      processMessageFn: async () => {
        throw new Error("malformed");
      },
      error: (m) => warnings.push(m),
    });

    expect(summary?.failed).toBe(1);
    expect(summary?.givenUp).toBe(1);
    // Give-up no longer holds the cursor: it advances to nowMs so the
    // wedge message falls out of the next query window entirely.
    expect(summary?.cursorAfter).toBe(now);

    const persisted = await loadBlueBubblesCatchupCursor("test-account");
    expect(persisted?.lastSeenMs).toBe(now);
    // Counter is persisted at the give-up value so a later sweep that
    // still sees the message (e.g., because a different GUID is holding
    // the cursor) will recognize the GUID as given up and skip it.
    expect(persisted?.failureRetries?.wedge).toBe(3);

    // Distinct WARN log line fired on the give-up transition.
    const giveUpWarnings = warnings.filter((w) => w.includes("giving up on guid="));
    expect(giveUpWarnings).toHaveLength(1);
    expect(giveUpWarnings[0]).toContain("guid=wedge");
    expect(giveUpWarnings[0]).toContain("3 consecutive failures");
  });

  it("skips an already-given-up GUID without re-attempting processMessage", async () => {
    // Setup: the cursor file was written with wedge already at the
    // give-up threshold from a prior run. On this run, the cursor is
    // held by a different, still-retrying GUID (`held`), so wedge's
    // timestamp falls back into the query window. Catchup must skip
    // wedge without invoking processMessage on it.
    const now = 10 * 60 * 1000;
    await saveBlueBubblesCatchupCursor("test-account", 5 * 60 * 1000, { wedge: 3 });

    const attempted: string[] = [];
    const target = makeTarget({
      account: {
        accountId: "test-account",
        enabled: true,
        configured: true,
        baseUrl: "http://127.0.0.1:1234",
        config: {
          serverUrl: "http://127.0.0.1:1234",
          password: "x",
          network: { dangerouslyAllowPrivateNetwork: true },
          catchup: { maxFailureRetries: 3 },
        } as unknown as WebhookTarget["account"]["config"],
      },
    });

    const summary = await runBlueBubblesCatchup(target, {
      now: () => now,
      fetchMessages: async () => ({
        resolved: true,
        messages: [
          makeBbMessage({ guid: "held", dateCreated: 6 * 60 * 1000 }),
          makeBbMessage({ guid: "wedge", dateCreated: 7 * 60 * 1000 }),
        ],
      }),
      processMessageFn: async (m) => {
        attempted.push(m.messageId ?? "?");
        if (m.messageId === "held") {
          throw new Error("transient");
        }
      },
    });

    // processMessage never runs for wedge.
    expect(attempted).toEqual(["held"]);
    expect(summary?.skippedGivenUp).toBe(1);
    expect(summary?.failed).toBe(1);
    expect(summary?.givenUp).toBe(0);
    // Cursor held at `held` so held keeps retrying next sweep.
    expect(summary?.cursorAfter).toBe(6 * 60 * 1000 - 1);

    const cursor = await loadBlueBubblesCatchupCursor("test-account");
    // Both entries preserved: held at count 1 (still retrying),
    // wedge at count 3 (given up, sticky).
    expect(cursor?.failureRetries?.held).toBe(1);
    expect(cursor?.failureRetries?.wedge).toBe(3);
  });

  it("clears the retry counter on successful processing", async () => {
    // GUID recovered after a transient failure. The counter must drop
    // so the next failure starts fresh (not carrying forward stale
    // retry history).
    const now = 10 * 60 * 1000;
    await saveBlueBubblesCatchupCursor("test-account", 5 * 60 * 1000, { flaky: 4 });

    const summary = await runBlueBubblesCatchup(makeTarget(), {
      now: () => now,
      fetchMessages: async () => ({
        resolved: true,
        messages: [makeBbMessage({ guid: "flaky", dateCreated: 6 * 60 * 1000 })],
      }),
      processMessageFn: async () => {
        /* succeeds */
      },
    });

    expect(summary?.replayed).toBe(1);
    const cursor = await loadBlueBubblesCatchupCursor("test-account");
    expect(cursor?.failureRetries?.flaky).toBeUndefined();
    // When the map is empty, the field itself is omitted from the file.
    expect(cursor?.failureRetries).toBeUndefined();
    expect(cursor?.lastSeenMs).toBe(now);
  });

  it("resolves 'earlier retry + later give-up' by holding cursor at earlier and skipping later", async () => {
    // This is the key scenario issue #66870 exists to solve. GUID A at
    // t=6min is still retrying (count=1). GUID B at t=7min has been
    // failing for many runs and crosses the ceiling on this run. The
    // wrong answer is "advance cursor past B to t=7min" — that would
    // lose A. The right answer is "hold cursor below A, record B as
    // given-up, skip B on sight next run".
    const now = 10 * 60 * 1000;
    await saveBlueBubblesCatchupCursor("test-account", 5 * 60 * 1000, { giveUpHere: 2 });

    const target = makeTarget({
      account: {
        accountId: "test-account",
        enabled: true,
        configured: true,
        baseUrl: "http://127.0.0.1:1234",
        config: {
          serverUrl: "http://127.0.0.1:1234",
          password: "x",
          network: { dangerouslyAllowPrivateNetwork: true },
          catchup: { maxFailureRetries: 3 },
        } as unknown as WebhookTarget["account"]["config"],
      },
    });

    const summary = await runBlueBubblesCatchup(target, {
      now: () => now,
      fetchMessages: async () => ({
        resolved: true,
        messages: [
          makeBbMessage({ guid: "retryEarlier", dateCreated: 6 * 60 * 1000 }),
          makeBbMessage({ guid: "giveUpHere", dateCreated: 7 * 60 * 1000 }),
        ],
      }),
      processMessageFn: async () => {
        throw new Error("failing");
      },
    });

    expect(summary?.failed).toBe(2);
    expect(summary?.givenUp).toBe(1);
    // Cursor held at (earlier message ts - 1) so retryEarlier keeps retrying.
    expect(summary?.cursorAfter).toBe(6 * 60 * 1000 - 1);

    const cursor = await loadBlueBubblesCatchupCursor("test-account");
    expect(cursor?.failureRetries?.retryEarlier).toBe(1);
    // Give-up counter preserved at or above the threshold.
    expect(cursor?.failureRetries?.giveUpHere).toBe(3);
  });

  it("uses the default retry cap when maxFailureRetries is omitted from config", async () => {
    // Boot-strap: record 9 failures, then a 10th should trigger give-up
    // at the default threshold. We pre-seed the counter at 9 so this
    // single-run test doesn't need to iterate the whole sequence.
    const now = 10 * 60 * 1000;
    await saveBlueBubblesCatchupCursor("test-account", 5 * 60 * 1000, { wedge: 9 });

    const warnings: string[] = [];
    const summary = await runBlueBubblesCatchup(makeTarget(), {
      now: () => now,
      fetchMessages: async () => ({
        resolved: true,
        messages: [makeBbMessage({ guid: "wedge", dateCreated: 6 * 60 * 1000 })],
      }),
      processMessageFn: async () => {
        throw new Error("boom");
      },
      error: (m) => warnings.push(m),
    });
    expect(summary?.givenUp).toBe(1);
    expect(warnings.some((w) => w.includes("giving up on guid=wedge"))).toBe(true);
    expect(warnings.some((w) => w.includes("10 consecutive failures"))).toBe(true);
  });

  it("clamps maxFailureRetries to >= 1 when configured to zero or negative", async () => {
    // With clamp floor of 1, the first failure already meets count >= 1
    // so catchup gives up immediately on first attempt.
    const now = 10 * 60 * 1000;
    await saveBlueBubblesCatchupCursor("test-account", 5 * 60 * 1000);

    const summary = await runBlueBubblesCatchup(
      makeTarget({
        account: {
          accountId: "test-account",
          enabled: true,
          configured: true,
          baseUrl: "http://127.0.0.1:1234",
          config: {
            serverUrl: "http://127.0.0.1:1234",
            password: "x",
            network: { dangerouslyAllowPrivateNetwork: true },
            catchup: { maxFailureRetries: 0 },
          } as unknown as WebhookTarget["account"]["config"],
        },
      }),
      {
        now: () => now,
        fetchMessages: async () => ({
          resolved: true,
          messages: [makeBbMessage({ guid: "wedge", dateCreated: 6 * 60 * 1000 })],
        }),
        processMessageFn: async () => {
          throw new Error("boom");
        },
      },
    );
    expect(summary?.givenUp).toBe(1);
    expect(summary?.cursorAfter).toBe(now);
  });

  it("loads cleanly from a legacy cursor file without a failureRetries field", async () => {
    // Older cursor files (written before this field existed) must still
    // parse. Round-trip: save without the field (legacy path), then
    // run catchup and confirm a normal sweep proceeds.
    await saveBlueBubblesCatchupCursor("test-account", 5 * 60 * 1000);
    const loaded = await loadBlueBubblesCatchupCursor("test-account");
    expect(loaded?.lastSeenMs).toBe(5 * 60 * 1000);
    expect(loaded?.failureRetries).toBeUndefined();

    const summary = await runBlueBubblesCatchup(makeTarget(), {
      now: () => 10 * 60 * 1000,
      fetchMessages: async () => ({
        resolved: true,
        messages: [makeBbMessage({ guid: "ok", dateCreated: 6 * 60 * 1000 })],
      }),
      processMessageFn: async () => {},
    });
    expect(summary?.replayed).toBe(1);
  });

  it("drops retry entries for GUIDs that are no longer in the query window", async () => {
    // A stale entry carried in the cursor file (e.g., from an older
    // run whose cursor has since advanced past its timestamp) should
    // NOT be carried forward if the GUID does not appear in the
    // current fetch. Otherwise the map grows without bound over time.
    const now = 10 * 60 * 1000;
    await saveBlueBubblesCatchupCursor("test-account", 5 * 60 * 1000, {
      staleGuid: 2,
      alsoStale: 5,
    });

    const summary = await runBlueBubblesCatchup(makeTarget(), {
      now: () => now,
      fetchMessages: async () => ({
        resolved: true,
        // Fetch returns entirely different GUIDs from the stored map.
        messages: [makeBbMessage({ guid: "fresh", dateCreated: 6 * 60 * 1000 })],
      }),
      processMessageFn: async () => {},
    });
    expect(summary?.replayed).toBe(1);
    const cursor = await loadBlueBubblesCatchupCursor("test-account");
    // Both stale entries dropped; no new entries since the fresh message
    // succeeded.
    expect(cursor?.failureRetries).toBeUndefined();
  });

  it("preserves stickiness when a given-up GUID reappears and fails again", async () => {
    // Setup: cursor advanced, but held by a newer still-retrying GUID
    // `held`. The wedge GUID is already given up from a prior run and
    // still appears because `held` is holding the cursor below it.
    // Catchup must continue to skip wedge on sight across many runs
    // without ever calling processMessage on it.
    const now = 10 * 60 * 1000;
    await saveBlueBubblesCatchupCursor("test-account", 5 * 60 * 1000, {
      wedge: 10,
      held: 1,
    });

    const attempted: string[] = [];
    const target = makeTarget({
      account: {
        accountId: "test-account",
        enabled: true,
        configured: true,
        baseUrl: "http://127.0.0.1:1234",
        config: {
          serverUrl: "http://127.0.0.1:1234",
          password: "x",
          network: { dangerouslyAllowPrivateNetwork: true },
          catchup: { maxFailureRetries: 5 },
        } as unknown as WebhookTarget["account"]["config"],
      },
    });
    const fetchMessages = async () => ({
      resolved: true,
      messages: [
        makeBbMessage({ guid: "held", dateCreated: 6 * 60 * 1000 }),
        makeBbMessage({ guid: "wedge", dateCreated: 7 * 60 * 1000 }),
      ],
    });
    const processMessageFn = async () => {
      throw new Error("still broken");
    };

    for (let i = 0; i < 3; i++) {
      await runBlueBubblesCatchup(target, {
        now: () => now + i,
        fetchMessages,
        processMessageFn: async (m) => {
          attempted.push(m.messageId ?? "?");
          return processMessageFn();
        },
      });
    }
    // wedge is NEVER attempted despite reappearing every sweep.
    expect(attempted.filter((g) => g === "wedge")).toHaveLength(0);
    // held is attempted every sweep.
    expect(attempted.filter((g) => g === "held")).toHaveLength(3);
  });

  it("summary.skippedGivenUp counter is zero on a clean run", async () => {
    const summary = await runBlueBubblesCatchup(makeTarget(), {
      now: () => 10_000,
      fetchMessages: async () => ({ resolved: true, messages: [] }),
      processMessageFn: async () => {},
    });
    expect(summary?.skippedGivenUp).toBe(0);
    expect(summary?.givenUp).toBe(0);
  });
});

describe("saveBlueBubblesCatchupCursor + loadBlueBubblesCatchupCursor — retry map", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = makeStateDir();
  });
  afterEach(() => {
    clearStateDir(stateDir);
  });

  it("round-trips an empty retry map by omitting the field from the persisted shape", async () => {
    await saveBlueBubblesCatchupCursor("acct", 100, {});
    const loaded = await loadBlueBubblesCatchupCursor("acct");
    expect(loaded?.lastSeenMs).toBe(100);
    expect(loaded?.failureRetries).toBeUndefined();
  });

  it("round-trips a populated retry map", async () => {
    await saveBlueBubblesCatchupCursor("acct", 100, { a: 1, b: 9 });
    const loaded = await loadBlueBubblesCatchupCursor("acct");
    expect(loaded?.failureRetries).toEqual({ a: 1, b: 9 });
  });

  it("filters malformed retry entries during load (zero, negative, non-numeric)", async () => {
    // Use the public save to produce the on-disk file, then overwrite
    // its contents with a hand-crafted payload to exercise the loader's
    // sanitization independently of what the saver would emit.
    await saveBlueBubblesCatchupCursor("acct", 100);
    const stateRoot = process.env.OPENCLAW_STATE_DIR;
    if (!stateRoot) {
      throw new Error("OPENCLAW_STATE_DIR must be set by the test harness");
    }
    const dir = path.join(stateRoot, "bluebubbles", "catchup");
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    const firstFile = files[0];
    if (!firstFile) {
      throw new Error("expected a cursor file to exist after save");
    }
    const badCursor = {
      lastSeenMs: 100,
      updatedAt: 0,
      failureRetries: {
        good: 3,
        zero: 0,
        negative: -1,
        notANumber: "oops",
        infinite: Number.POSITIVE_INFINITY,
        nan: Number.NaN,
      },
    };
    fs.writeFileSync(path.join(dir, firstFile), JSON.stringify(badCursor));

    const loaded = await loadBlueBubblesCatchupCursor("acct");
    expect(loaded?.lastSeenMs).toBe(100);
    expect(loaded?.failureRetries).toEqual({ good: 3 });
  });
});

describe("fetchBlueBubblesMessagesSince", () => {
  it("returns resolved:false when the network call throws", async () => {
    // Point at a port nothing is listening on so fetch fails fast.
    const result = await fetchBlueBubblesMessagesSince(0, 10, {
      baseUrl: "http://127.0.0.1:1",
      password: "x",
      allowPrivateNetwork: true,
      timeoutMs: 200,
    });
    expect(result.resolved).toBe(false);
    expect(result.messages).toEqual([]);
  });
});
