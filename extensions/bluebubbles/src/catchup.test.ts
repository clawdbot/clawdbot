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
    expect(summary?.cursorAfter).toBe(7 * 60 * 1000 - 1);
    const cursorAfter = await loadBlueBubblesCatchupCursor("test-account");
    expect(cursorAfter?.lastSeenMs).toBe(7 * 60 * 1000 - 1);
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
