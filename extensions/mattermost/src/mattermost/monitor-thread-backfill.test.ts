// Mattermost tests cover thread-history recovery for cold inbound turns (#93204).
import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import {
  createMattermostThreadBackfill,
  MATTERMOST_THREAD_PER_PAGE_MAX,
  mayAttemptRecovery,
  resolveRecoveryMarker,
  resolveThreadFetchLimit,
  THREAD_BACKFILL_COOLDOWN_MS,
  THREAD_BACKFILL_MAX_ATTEMPTS,
} from "./monitor-thread-backfill.js";
import type { HistoryEntry } from "./runtime-api.js";

const HISTORY_KEY = "agent:main:mattermost:channel:c1:thread:root-1";
const AGENT_ID = "main";
const THREAD_ROOT_ID = "root-1";
const CURRENT_POST_ID = "current-post";

const mattermostApiError = (status: number, statusText: string) =>
  new Error(`Mattermost API ${status} ${statusText}: detail`);

const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

const threadResponse = (count: number) => ({
  order: Array.from({ length: count }, (_, index) => `p${index}`),
  posts: Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `p${index}`,
      {
        id: `p${index}`,
        user_id: `u${index}`,
        message: `message ${index}`,
        create_at: 1_000 + index,
      },
    ]),
  ),
});

function createHarness(options: {
  responses: (unknown | Error)[];
  sessionId?: string | undefined;
  historyLimit?: number;
  channelHistories?: Map<string, HistoryEntry[]>;
}) {
  const requests: { path: string; timeoutMs?: number }[] = [];
  let currentSessionId = options.sessionId ?? "session-a";
  let clock = 1_000_000;
  const responses = [...options.responses];

  const client = {
    request: vi.fn(async (path: string, init?: { timeoutMs?: number }) => {
      requests.push({ path, timeoutMs: init?.timeoutMs });
      const next = responses.shift();
      if (next instanceof Error) {
        throw next;
      }
      return next;
    }),
  } as unknown as MattermostClient;

  const channelHistories = options.channelHistories ?? new Map<string, HistoryEntry[]>();
  const backfill = createMattermostThreadBackfill({
    client,
    channelHistories,
    historyLimit: options.historyLimit ?? 10,
    resolveSessionId: () => currentSessionId,
    now: () => clock,
  });

  return {
    requests,
    channelHistories,
    advance: (ms: number) => {
      clock += ms;
    },
    rotateSession: (sessionId: string | undefined) => {
      currentSessionId = sessionId as string;
    },
    turn: () =>
      backfill.ensureThreadHistory({
        historyKey: HISTORY_KEY,
        threadRootId: THREAD_ROOT_ID,
        currentPostId: CURRENT_POST_ID,
        agentId: AGENT_ID,
      }),
  };
}

describe("resolveThreadFetchLimit", () => {
  it("requests one extra post so the current post can be filtered out", () => {
    expect(resolveThreadFetchLimit(10)).toBe(11);
  });

  it("never requests fewer than one post", () => {
    expect(resolveThreadFetchLimit(0)).toBe(1);
  });

  it("clamps to the documented Mattermost maximum instead of relying on truncation", () => {
    expect(resolveThreadFetchLimit(199)).toBe(MATTERMOST_THREAD_PER_PAGE_MAX);
    expect(resolveThreadFetchLimit(5_000)).toBe(MATTERMOST_THREAD_PER_PAGE_MAX);
  });
});

describe("resolveRecoveryMarker", () => {
  it("keys recovery to the stored session id once the store has one", () => {
    expect(resolveRecoveryMarker({ historyKey: HISTORY_KEY, sessionId: "s1" })).toBe("session:s1");
  });

  it("falls back to a pending marker before the session id exists", () => {
    expect(resolveRecoveryMarker({ historyKey: HISTORY_KEY, sessionId: undefined })).toBe(
      `pending:${HISTORY_KEY}`,
    );
  });
});

describe("mayAttemptRecovery", () => {
  const base = { marker: "session:s1", maxAttempts: 3 };

  it("allows the first attempt", () => {
    expect(mayAttemptRecovery({ ...base, record: undefined, now: 0 })).toBe(true);
  });

  it("ignores a record left by a different marker", () => {
    expect(
      mayAttemptRecovery({
        ...base,
        record: { marker: "session:old", attempts: 3, nextAttemptAt: Number.MAX_SAFE_INTEGER },
        now: 0,
      }),
    ).toBe(true);
  });

  it("blocks while the cooldown has not elapsed", () => {
    expect(
      mayAttemptRecovery({
        ...base,
        record: { marker: "session:s1", attempts: 1, nextAttemptAt: 5_000 },
        now: 4_999,
      }),
    ).toBe(false);
  });

  it("allows the attempt once the cooldown elapses", () => {
    expect(
      mayAttemptRecovery({
        ...base,
        record: { marker: "session:s1", attempts: 1, nextAttemptAt: 5_000 },
        now: 5_000,
      }),
    ).toBe(true);
  });

  it("blocks once the attempt budget is spent", () => {
    expect(
      mayAttemptRecovery({
        ...base,
        record: { marker: "session:s1", attempts: 3, nextAttemptAt: 0 },
        now: Number.MAX_SAFE_INTEGER,
      }),
    ).toBe(false);
  });
});

describe("createMattermostThreadBackfill", () => {
  it("seeds a cold thread from the server and skips the post being handled", async () => {
    const harness = createHarness({
      responses: [
        {
          order: ["p0", CURRENT_POST_ID],
          posts: {
            p0: { id: "p0", user_id: "u0", message: "earlier", create_at: 10 },
            [CURRENT_POST_ID]: {
              id: CURRENT_POST_ID,
              user_id: "u1",
              message: "now",
              create_at: 20,
            },
          },
        },
      ],
    });

    await harness.turn();

    expect(harness.channelHistories.get(HISTORY_KEY)).toEqual([
      { sender: "u0", body: "earlier", timestamp: 10, messageId: "p0" },
    ]);
  });

  it("bounds the request with the inbound timeout and the clamped page size", async () => {
    const harness = createHarness({ responses: [threadResponse(2)], historyLimit: 5_000 });

    await harness.turn();

    expect(harness.requests[0]?.path).toContain(`perPage=${MATTERMOST_THREAD_PER_PAGE_MAX}`);
    expect(harness.requests[0]?.timeoutMs).toBe(5_000);
  });

  it("labels attachment-only posts instead of dropping them", async () => {
    const harness = createHarness({
      responses: [{ order: ["p0"], posts: { p0: { id: "p0", user_id: "u0", create_at: 10 } } }],
    });

    await harness.turn();

    expect(harness.channelHistories.get(HISTORY_KEY)?.[0]?.body).toBe("[attachment]");
  });

  it("recovers only once per stored session", async () => {
    const harness = createHarness({
      responses: [threadResponse(3), threadResponse(3), threadResponse(3)],
    });

    await harness.turn();
    await harness.turn();
    harness.advance(600_000);
    await harness.turn();

    expect(harness.requests).toHaveLength(1);
  });

  it("does not fetch when the thread already has an in-memory window", async () => {
    const channelHistories = new Map<string, HistoryEntry[]>([
      [HISTORY_KEY, [{ sender: "u0", body: "still warm" }]],
    ]);
    const harness = createHarness({ responses: [threadResponse(3)], channelHistories });

    await harness.turn();

    expect(harness.requests).toHaveLength(0);
  });

  it("makes one request when concurrent cold turns race", async () => {
    const harness = createHarness({ responses: [threadResponse(3), threadResponse(3)] });

    await Promise.all([harness.turn(), harness.turn()]);

    expect(harness.requests).toHaveLength(1);
  });

  it("schedules a retry after a transient failure instead of marking the session attempted", async () => {
    const harness = createHarness({
      responses: [mattermostApiError(500, "Internal Server Error"), threadResponse(3)],
    });

    await harness.turn();
    expect(harness.requests).toHaveLength(1);
    expect(harness.channelHistories.has(HISTORY_KEY)).toBe(false);

    harness.advance(THREAD_BACKFILL_COOLDOWN_MS);
    await harness.turn();

    expect(harness.requests).toHaveLength(2);
    expect(harness.channelHistories.get(HISTORY_KEY)).toHaveLength(3);
  });

  it("holds the retry until the cooldown elapses", async () => {
    const harness = createHarness({
      responses: [mattermostApiError(503, "Service Unavailable"), threadResponse(3)],
    });

    await harness.turn();
    harness.advance(THREAD_BACKFILL_COOLDOWN_MS - 1);
    await harness.turn();

    expect(harness.requests).toHaveLength(1);
  });

  it("treats rate limiting and inbound timeouts as retryable", async () => {
    const rateLimited = createHarness({
      responses: [mattermostApiError(429, "Too Many Requests"), threadResponse(2)],
    });
    await rateLimited.turn();
    rateLimited.advance(THREAD_BACKFILL_COOLDOWN_MS);
    await rateLimited.turn();
    expect(rateLimited.requests).toHaveLength(2);

    const timedOut = createHarness({ responses: [abortError(), threadResponse(2)] });
    await timedOut.turn();
    timedOut.advance(THREAD_BACKFILL_COOLDOWN_MS);
    await timedOut.turn();
    expect(timedOut.requests).toHaveLength(2);
  });

  it("stops after the attempt budget is spent", async () => {
    const harness = createHarness({
      responses: Array.from({ length: 10 }, () => mattermostApiError(500, "Internal Server Error")),
    });

    for (let index = 0; index < 8; index += 1) {
      await harness.turn();
      harness.advance(THREAD_BACKFILL_COOLDOWN_MS);
    }

    expect(harness.requests).toHaveLength(THREAD_BACKFILL_MAX_ATTEMPTS);
  });

  it("never retries a permanent failure", async () => {
    const harness = createHarness({
      responses: Array.from({ length: 5 }, () => mattermostApiError(403, "Forbidden")),
    });

    for (let index = 0; index < 4; index += 1) {
      await harness.turn();
      harness.advance(THREAD_BACKFILL_COOLDOWN_MS);
    }

    expect(harness.requests).toHaveLength(1);
  });

  it("keeps retrying when the failed turn's own message rebuilds the window", async () => {
    const harness = createHarness({
      responses: [mattermostApiError(500, "Internal Server Error"), threadResponse(4)],
    });

    await harness.turn();
    // The kernel records the message that just arrived, so the window is no
    // longer empty even though the thread is still missing its history.
    harness.channelHistories.set(HISTORY_KEY, [{ sender: "u9", body: "the message just handled" }]);
    harness.advance(THREAD_BACKFILL_COOLDOWN_MS);
    await harness.turn();

    expect(harness.requests).toHaveLength(2);
    expect(harness.channelHistories.get(HISTORY_KEY)).toHaveLength(4);
  });

  it("gives a rotated session its own attempt budget", async () => {
    const harness = createHarness({
      responses: Array.from({ length: 10 }, () => mattermostApiError(500, "Internal Server Error")),
    });

    for (let index = 0; index < 5; index += 1) {
      await harness.turn();
      harness.advance(THREAD_BACKFILL_COOLDOWN_MS);
    }
    expect(harness.requests).toHaveLength(THREAD_BACKFILL_MAX_ATTEMPTS);

    harness.rotateSession("session-b");
    await harness.turn();

    expect(harness.requests).toHaveLength(THREAD_BACKFILL_MAX_ATTEMPTS + 1);
  });

  it("adopts the real session id after a pending recovery settles", async () => {
    const harness = createHarness({ responses: [threadResponse(2), threadResponse(2)] });
    harness.rotateSession(undefined);

    await harness.turn();
    expect(harness.requests).toHaveLength(1);

    harness.rotateSession("session-a");
    await harness.turn();

    // Adopting the id must not re-fetch: the pending recovery already ran.
    expect(harness.requests).toHaveLength(1);
  });

  it("discards a completion whose session rotated mid-flight", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const channelHistories = new Map<string, HistoryEntry[]>();
    const client = {
      request: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          await firstGate;
          return threadResponse(3);
        }
        return threadResponse(1);
      }),
    } as unknown as MattermostClient;
    let sessionId = "session-a";
    const backfill = createMattermostThreadBackfill({
      client,
      channelHistories,
      historyLimit: 10,
      resolveSessionId: () => sessionId,
    });
    const turn = () =>
      backfill.ensureThreadHistory({
        historyKey: HISTORY_KEY,
        threadRootId: THREAD_ROOT_ID,
        currentPostId: CURRENT_POST_ID,
        agentId: AGENT_ID,
      });

    const stale = turn();
    sessionId = "session-b";
    await turn();
    expect(channelHistories.get(HISTORY_KEY)).toHaveLength(1);

    releaseFirst();
    await stale;

    // The older session's three entries must not overwrite the window the
    // current session already recovered.
    expect(channelHistories.get(HISTORY_KEY)).toHaveLength(1);
  });

  it("evicts the oldest recovery state instead of growing without bound", async () => {
    const client = {
      request: vi.fn(async () => threadResponse(1)),
    } as unknown as MattermostClient;
    const channelHistories = new Map<string, HistoryEntry[]>();
    const backfill = createMattermostThreadBackfill({
      client,
      channelHistories,
      historyLimit: 10,
      resolveSessionId: () => "session-a",
      markerCap: 5,
    });

    for (let index = 0; index < 20; index += 1) {
      await backfill.ensureThreadHistory({
        historyKey: `key-${index}`,
        threadRootId: `root-${index}`,
        currentPostId: CURRENT_POST_ID,
        agentId: AGENT_ID,
      });
    }

    // Every key is cold, so an unbounded map would hold 20 markers; the cap
    // keeps only the most recent ones, and the evicted keys simply recover
    // again if they are ever seen once more.
    expect(client.request).toHaveBeenCalledTimes(20);
    for (let index = 0; index < 20; index += 1) {
      await backfill.ensureThreadHistory({
        historyKey: `key-${index}`,
        threadRootId: `root-${index}`,
        currentPostId: CURRENT_POST_ID,
        agentId: AGENT_ID,
      });
    }
    expect(client.request.mock.calls.length).toBeLessThan(40);
  });

  it("does nothing when history is disabled", async () => {
    const client = {
      request: vi.fn(async () => threadResponse(3)),
    } as unknown as MattermostClient;
    const backfill = createMattermostThreadBackfill({
      client,
      channelHistories: new Map(),
      historyLimit: 0,
      resolveSessionId: () => "session-a",
    });

    await backfill.ensureThreadHistory({
      historyKey: HISTORY_KEY,
      threadRootId: THREAD_ROOT_ID,
      currentPostId: CURRENT_POST_ID,
      agentId: AGENT_ID,
    });

    expect(client.request).not.toHaveBeenCalled();
  });
});
