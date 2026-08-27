// Mattermost tests cover thread-history recovery for cold inbound turns (#93204).
import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import { createMattermostThreadBackfill } from "./monitor-thread-backfill.js";
import type { ChatType, HistoryEntry } from "./runtime-api.js";

const HISTORY_KEY = "agent:main:mattermost:channel:c1:thread:root-1";
const AGENT_ID = "main";
const THREAD_ROOT_ID = "root-1";
const CURRENT_POST_ID = "current-post";
const CHANNEL_ID = "c1";
const CONVERSATION = { channelId: CHANNEL_ID, kind: "channel" } as const;
// Mirrors the module defaults; the module keeps them private so the behavior is
// asserted through the factory rather than through its constants.
const PER_PAGE_MAX = 200;
const COOLDOWN_MS = 60_000;
const MAX_ATTEMPTS = 3;
const INBOUND_TIMEOUT_MS = 5_000;

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
  responses: unknown[];
  sessionId?: string | undefined;
  historyLimit?: number;
  channelHistories?: Map<string, HistoryEntry[]>;
  shouldRetainSenderHistory?: (params: {
    senderId: string;
    channelId: string;
    kind: ChatType;
  }) => boolean | Promise<boolean>;
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
    ...(options.shouldRetainSenderHistory
      ? { shouldRetainSenderHistory: options.shouldRetainSenderHistory }
      : {}),
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
        ...CONVERSATION,
      }),
  };
}

describe("thread page size", () => {
  it.each([
    {
      historyLimit: 10,
      perPage: 11,
      why: "one extra post so the handled post can be filtered out",
    },
    { historyLimit: 1, perPage: 2, why: "the smallest window still asks for one extra" },
    { historyLimit: 199, perPage: PER_PAGE_MAX, why: "clamped at the Mattermost maximum" },
    { historyLimit: 5_000, perPage: PER_PAGE_MAX, why: "clamped instead of relying on truncation" },
  ])("requests perPage=$perPage for historyLimit=$historyLimit ($why)", async (testCase) => {
    const harness = createHarness({
      responses: [threadResponse(1)],
      historyLimit: testCase.historyLimit,
    });

    await harness.turn();

    expect(harness.requests[0]?.path).toContain(`perPage=${testCase.perPage}`);
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

    expect(harness.requests[0]?.path).toContain(`perPage=${PER_PAGE_MAX}`);
    expect(harness.requests[0]?.timeoutMs).toBe(INBOUND_TIMEOUT_MS);
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

  it("drops recovered posts from senders whose history the inbound path would omit", async () => {
    const harness = createHarness({
      responses: [threadResponse(3)],
      // u1 is the denied sender: the inbound path would have dropped its message
      // without recording it, so recovery must not read it back from the server.
      shouldRetainSenderHistory: ({ senderId }) => senderId !== "u1",
    });

    await harness.turn();

    const seeded = harness.channelHistories.get(HISTORY_KEY) ?? [];
    expect(seeded.map((entry) => entry.sender)).toEqual(["u0", "u2"]);
  });

  it("resolves retention asynchronously against the conversation, once per sender", async () => {
    const asked: Array<{ senderId: string; channelId: string; kind: ChatType }> = [];
    const harness = createHarness({
      responses: [
        {
          order: ["p0", "p1", "p2"],
          posts: {
            p0: { id: "p0", user_id: "u0", message: "first", create_at: 10 },
            // The same denied sender twice: the effective policy is resolved
            // through the ingress runtime, so it must not be asked per post.
            p1: { id: "p1", user_id: "u1", message: "denied", create_at: 20 },
            p2: { id: "p2", user_id: "u1", message: "denied again", create_at: 30 },
          },
        },
      ],
      shouldRetainSenderHistory: async (params) => {
        asked.push(params);
        return params.senderId !== "u1";
      },
    });

    await harness.turn();

    expect(asked).toEqual([
      { senderId: "u0", channelId: CHANNEL_ID, kind: "channel" },
      { senderId: "u1", channelId: CHANNEL_ID, kind: "channel" },
    ]);
    expect(harness.channelHistories.get(HISTORY_KEY)?.map((entry) => entry.sender)).toEqual(["u0"]);
  });

  it("starts every sender resolution before awaiting any of them", async () => {
    // Resolving a sender can reach the Mattermost user API, whose timeout is
    // far above the bound on the thread fetch. Awaiting each one in turn would
    // multiply that cost by the number of senders in the thread.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const harness = createHarness({
      responses: [threadResponse(3)],
      shouldRetainSenderHistory: async ({ senderId }) => {
        started.push(senderId);
        await gate;
        return true;
      },
    });

    const turn = harness.turn();
    await vi.waitFor(() => expect(started).toEqual(["u0", "u1", "u2"]));
    release();
    await turn;

    expect(harness.channelHistories.get(HISTORY_KEY)).toHaveLength(3);
  });

  it("keeps the newest retained posts when the window is smaller than the thread", async () => {
    // Retention has to be applied before the window is sliced, or dropping a
    // denied sender would shrink the recovered window instead of admitting an
    // older allowed post.
    const harness = createHarness({
      responses: [threadResponse(4)],
      historyLimit: 2,
      shouldRetainSenderHistory: ({ senderId }) => senderId !== "u3",
    });

    await harness.turn();

    expect(harness.channelHistories.get(HISTORY_KEY)?.map((entry) => entry.sender)).toEqual([
      "u1",
      "u2",
    ]);
  });

  it("keeps every recovered post when context visibility opts denied senders in", async () => {
    const harness = createHarness({ responses: [threadResponse(3)] });

    await harness.turn();

    const seeded = harness.channelHistories.get(HISTORY_KEY) ?? [];
    expect(seeded.map((entry) => entry.sender)).toEqual(["u0", "u1", "u2"]);
  });

  it("seeds through the bounded history owner so the map stays capped", async () => {
    // One key short of the shared 1,000-key cap, so seeding one recovered thread
    // has to evict rather than grow the map.
    const channelHistories = new Map<string, HistoryEntry[]>(
      Array.from({ length: 1000 }, (_, index): [string, HistoryEntry[]] => [
        `agent:main:mattermost:channel:unrelated-${index}:thread:root-${index}`,
        [{ sender: "u0", body: `unrelated ${index}` }],
      ]),
    );
    const harness = createHarness({ responses: [threadResponse(3)], channelHistories });

    await harness.turn();

    expect(harness.requests).toHaveLength(1);
    expect(channelHistories.get(HISTORY_KEY)).toHaveLength(3);
    expect(channelHistories.size).toBe(1000);
  });

  it("recovers again after the shared owner evicts the recovered window", async () => {
    const channelHistories = new Map<string, HistoryEntry[]>();
    const harness = createHarness({
      responses: [threadResponse(3), threadResponse(4)],
      channelHistories,
    });

    await harness.turn();
    expect(harness.requests).toHaveLength(1);

    // An emptied window keeps its key, so that alone must not trigger a refetch.
    channelHistories.set(HISTORY_KEY, []);
    await harness.turn();
    expect(harness.requests).toHaveLength(1);

    // LRU eviction removes the key outright; the marker now vouches for a window
    // that no longer exists, so the next turn has to rebuild it.
    channelHistories.delete(HISTORY_KEY);
    await harness.turn();

    expect(harness.requests).toHaveLength(2);
    expect(channelHistories.get(HISTORY_KEY)).toHaveLength(4);
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

    harness.advance(COOLDOWN_MS);
    await harness.turn();

    expect(harness.requests).toHaveLength(2);
    expect(harness.channelHistories.get(HISTORY_KEY)).toHaveLength(3);
  });

  it("holds the retry until the cooldown elapses", async () => {
    const harness = createHarness({
      responses: [mattermostApiError(503, "Service Unavailable"), threadResponse(3)],
    });

    await harness.turn();
    harness.advance(COOLDOWN_MS - 1);
    await harness.turn();

    expect(harness.requests).toHaveLength(1);
  });

  it("treats rate limiting and inbound timeouts as retryable", async () => {
    const rateLimited = createHarness({
      responses: [mattermostApiError(429, "Too Many Requests"), threadResponse(2)],
    });
    await rateLimited.turn();
    rateLimited.advance(COOLDOWN_MS);
    await rateLimited.turn();
    expect(rateLimited.requests).toHaveLength(2);

    const timedOut = createHarness({ responses: [abortError(), threadResponse(2)] });
    await timedOut.turn();
    timedOut.advance(COOLDOWN_MS);
    await timedOut.turn();
    expect(timedOut.requests).toHaveLength(2);
  });

  it("stops after the attempt budget is spent", async () => {
    const harness = createHarness({
      responses: Array.from({ length: 10 }, () => mattermostApiError(500, "Internal Server Error")),
    });

    for (let index = 0; index < 8; index += 1) {
      await harness.turn();
      harness.advance(COOLDOWN_MS);
    }

    expect(harness.requests).toHaveLength(MAX_ATTEMPTS);
  });

  it("never retries a permanent failure", async () => {
    const harness = createHarness({
      responses: Array.from({ length: 5 }, () => mattermostApiError(403, "Forbidden")),
    });

    for (let index = 0; index < 4; index += 1) {
      await harness.turn();
      harness.advance(COOLDOWN_MS);
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
    harness.advance(COOLDOWN_MS);
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
      harness.advance(COOLDOWN_MS);
    }
    expect(harness.requests).toHaveLength(MAX_ATTEMPTS);

    harness.rotateSession("session-b");
    await harness.turn();

    expect(harness.requests).toHaveLength(MAX_ATTEMPTS + 1);
  });

  it("keeps the cooldown and the budget when the pending session materializes", async () => {
    const harness = createHarness({
      responses: Array.from({ length: 10 }, () => mattermostApiError(500, "Internal Server Error")),
    });
    harness.rotateSession(undefined);

    await harness.turn();
    expect(harness.requests).toHaveLength(1);

    // The store settles the session id between turns. The failure recorded under
    // the pending marker is still this thread's, so the marker rotating must not
    // hand the next turn a fresh cooldown or a fresh budget.
    harness.rotateSession("session-a");
    harness.advance(COOLDOWN_MS - 1);
    await harness.turn();
    expect(harness.requests).toHaveLength(1);

    for (let index = 0; index < 5; index += 1) {
      harness.advance(COOLDOWN_MS);
      await harness.turn();
    }

    expect(harness.requests).toHaveLength(MAX_ATTEMPTS);
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

  it("carries the seeded window across adoption so a later eviction still recovers", async () => {
    const channelHistories = new Map<string, HistoryEntry[]>();
    const harness = createHarness({
      responses: [threadResponse(2), threadResponse(3)],
      channelHistories,
    });
    harness.rotateSession(undefined);

    // The window is recovered while the store still has no session id, so it is
    // recorded as seeded under the pending marker.
    await harness.turn();
    expect(harness.requests).toHaveLength(1);

    // The store settles and the marker rotates to the real session id.
    harness.rotateSession("session-a");
    await harness.turn();
    expect(harness.requests).toHaveLength(1);

    // Ownership of the seeded window has to rotate with the marker. If it stays
    // behind, this eviction is unreadable as one and recovery is suppressed for
    // the rest of the session.
    channelHistories.delete(HISTORY_KEY);
    await harness.turn();

    expect(harness.requests).toHaveLength(2);
    expect(channelHistories.get(HISTORY_KEY)).toHaveLength(3);
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
        ...CONVERSATION,
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
    const request = vi.fn(async () => threadResponse(1));
    const client = { request } as unknown as MattermostClient;
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
        ...CONVERSATION,
      });
    }

    // Every key is cold, so an unbounded map would hold 20 markers; the cap
    // keeps only the most recent ones, and the evicted keys simply recover
    // again if they are ever seen once more.
    expect(request).toHaveBeenCalledTimes(20);
    for (let index = 0; index < 20; index += 1) {
      await backfill.ensureThreadHistory({
        historyKey: `key-${index}`,
        threadRootId: `root-${index}`,
        currentPostId: CURRENT_POST_ID,
        agentId: AGENT_ID,
        ...CONVERSATION,
      });
    }
    expect(request.mock.calls.length).toBeLessThan(40);
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
      ...CONVERSATION,
    });

    expect(client.request).not.toHaveBeenCalled();
  });
});
