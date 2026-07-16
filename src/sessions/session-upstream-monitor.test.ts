import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionCatalogProvider, SessionUpstreamProbe } from "../plugins/session-catalog.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { listSessionStateEventsSince, registerSessionStateWatch } from "./session-state-events.js";
import {
  deleteSessionUpstreamLink,
  readSessionUpstreamLink,
  upsertSessionUpstreamLink,
} from "./session-upstream-links.js";
import { runSessionUpstreamMonitorTick } from "./session-upstream-monitor.test-support.js";

const tempDirs: string[] = [];
const watcherSessionKey = "agent:main:main";

function createMissingCounts() {
  return new Map<string, { count: number; linkUpdatedAt: number }>();
}

function createDatabaseOptions() {
  const stateDir = makeTempDir(tempDirs, "openclaw-session-upstream-monitor-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function createLink(
  sessionKey: string,
  catalogId: string,
  database: ReturnType<typeof createDatabaseOptions>,
  watched = true,
) {
  upsertSessionUpstreamLink(
    {
      sessionKey,
      agentId: "main",
      catalogId,
      hostId: "gateway:local",
      threadId: `thread-${catalogId}`,
      upstreamKind: catalogId === "claude" ? "claude-cli" : "codex-app-server",
      upstreamRef: { source: catalogId },
      marker: { offset: 0 },
    },
    database,
  );
  if (watched) {
    registerSessionStateWatch({ watcherSessionKey, targetSessionKey: sessionKey }, database);
  }
}

function provider(
  id: string,
  checkUpstreamActivity: NonNullable<SessionCatalogProvider["checkUpstreamActivity"]>,
): SessionCatalogProvider {
  return {
    id,
    label: id,
    list: async () => [],
    read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
    checkUpstreamActivity,
  };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("session upstream monitor", () => {
  it("records watched activity once and advances its marker", async () => {
    const database = createDatabaseOptions();
    const watched = "agent:main:adopted:watched";
    const unwatched = "agent:main:adopted:unwatched";
    createLink(watched, "claude", database);
    createLink(unwatched, "claude", database, false);
    const checkUpstreamActivity = vi.fn(async (probes: SessionUpstreamProbe[]) =>
      probes.map((probe) => ({
        kind: "activity" as const,
        sessionKey: probe.sessionKey,
        occurredAt: 2_000,
        humanTurns: 1,
        nextMarker: { offset: 8 },
        dedupeId: "8",
      })),
    );
    const claude = provider("claude", checkUpstreamActivity);
    const loadEntry = vi.fn(() => ({ sessionId: "session-watched" }) as never);

    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [claude],
      now: () => 3_000,
      loadEntry,
      loadOwnRecentUserTexts: async () => [],
    });
    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [claude],
      now: () => 4_000,
      loadEntry,
      loadOwnRecentUserTexts: async () => [],
    });

    expect(checkUpstreamActivity).toHaveBeenCalledTimes(2);
    expect(checkUpstreamActivity.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ sessionKey: watched, marker: { offset: 0 } }),
    ]);
    expect(checkUpstreamActivity.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({ sessionKey: watched, marker: { offset: 8 } }),
    ]);
    const events = listSessionStateEventsSince(watched, "main", 0, 20, database).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        kind: "human_direct_message",
        summary: "human message via claude",
        occurredAt: 2_000,
      }),
    );
    expect(events[0]?.payload).toBeUndefined();
    const dedupeRow = openOpenClawStateDatabase(database)
      .db.prepare("SELECT dedupe_key FROM session_state_events WHERE session_key = ?")
      .get(watched) as { dedupe_key: string };
    // Source identity is hashed into the dedupe key so a rebased source cannot
    // collide with a prior source's activity id.
    expect(dedupeRow.dedupe_key).toMatch(new RegExp(`^upstream:${watched}:[0-9a-f]{16}:8$`));
  });

  it("records one upstream-missing event after three misses and removes the link", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:missing";
    createLink(sessionKey, "claude", database);
    const check = vi.fn(async (probes: SessionUpstreamProbe[]) =>
      probes.map((probe) => ({ kind: "missing" as const, sessionKey: probe.sessionKey })),
    );
    const options = {
      ...database,
      providers: [provider("claude", check)],
      now: () => 3_000,
      loadEntry: () => ({ sessionId: "session-missing" }) as never,
      loadOwnRecentUserTexts: async () => [],
    };
    const missingCounts = createMissingCounts();

    await runSessionUpstreamMonitorTick(options, missingCounts);
    await runSessionUpstreamMonitorTick(options, missingCounts);
    await runSessionUpstreamMonitorTick(options, missingCounts);
    await runSessionUpstreamMonitorTick(options, missingCounts);

    expect(check).toHaveBeenCalledTimes(3);
    expect(readSessionUpstreamLink(sessionKey, "main", database)).toBeUndefined();
    expect(missingCounts.size).toBe(0);
    expect(listSessionStateEventsSince(sessionKey, "main", 0, 20, database).events).toEqual([
      expect.objectContaining({
        kind: "upstream_missing",
        actorType: "system",
        summary: "upstream missing via claude",
        payload: { channel: "claude" },
      }),
    ]);
  });

  it("resets consecutive misses on activity", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:missing-reset";
    createLink(sessionKey, "claude", database);
    let scan = 0;
    const check = vi.fn(async () => {
      scan += 1;
      return scan === 3
        ? [
            {
              kind: "activity" as const,
              sessionKey,
              humanTurns: 0,
              nextMarker: { offset: 3 },
            },
          ]
        : [{ kind: "missing" as const, sessionKey }];
    });
    const options = {
      ...database,
      providers: [provider("claude", check)],
      loadEntry: () => ({ sessionId: "session-missing-reset" }) as never,
      loadOwnRecentUserTexts: async () => [],
    };
    const missingCounts = createMissingCounts();

    for (let index = 0; index < 5; index += 1) {
      await runSessionUpstreamMonitorTick(options, missingCounts);
    }

    expect(check).toHaveBeenCalledTimes(5);
    expect(listSessionStateEventsSince(sessionKey, "main", 0, 20, database).events).toEqual([]);
    expect(readSessionUpstreamLink(sessionKey, "main", database)).toBeDefined();
    expect([...missingCounts.values()].map((counter) => counter.count)).toEqual([2]);
  });

  it("breaks a missing streak when a successful probe has no missing outcome", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:missing-quiet";
    createLink(sessionKey, "claude", database);
    let scan = 0;
    const check = vi.fn(async () => {
      scan += 1;
      return scan === 2 ? [] : [{ kind: "missing" as const, sessionKey }];
    });
    const options = {
      ...database,
      providers: [provider("claude", check)],
      loadEntry: () => ({ sessionId: "session-missing-quiet" }) as never,
      loadOwnRecentUserTexts: async () => [],
    };
    const missingCounts = createMissingCounts();

    for (let index = 0; index < 4; index += 1) {
      await runSessionUpstreamMonitorTick(options, missingCounts);
    }

    expect(listSessionStateEventsSince(sessionKey, "main", 0, 20, database).events).toEqual([]);
    expect(readSessionUpstreamLink(sessionKey, "main", database)).toBeDefined();
    expect([...missingCounts.values()].map((counter) => counter.count)).toEqual([2]);
  });

  it("starts a fresh streak when Continue refreshes the same source", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:missing-same-source";
    createLink(sessionKey, "claude", database);
    const check = vi.fn(async () => [{ kind: "missing" as const, sessionKey }]);
    const options = {
      ...database,
      providers: [provider("claude", check)],
      loadEntry: () => ({ sessionId: "session-missing-same-source" }) as never,
      loadOwnRecentUserTexts: async () => [],
    };
    const missingCounts = createMissingCounts();

    await runSessionUpstreamMonitorTick(options, missingCounts);
    await runSessionUpstreamMonitorTick(options, missingCounts);
    upsertSessionUpstreamLink(
      {
        sessionKey,
        agentId: "main",
        catalogId: "claude",
        hostId: "gateway:local",
        threadId: "thread-claude",
        upstreamKind: "claude-cli",
        upstreamRef: { source: "claude" },
        marker: { offset: 0 },
      },
      { ...database, now: 7_777 },
    );
    await runSessionUpstreamMonitorTick(options, missingCounts);

    expect(listSessionStateEventsSince(sessionKey, "main", 0, 20, database).events).toEqual([]);
    expect(readSessionUpstreamLink(sessionKey, "main", database)).toBeDefined();
    expect([...missingCounts.values()].map((counter) => counter.count)).toEqual([1]);
  });

  it("aborts missing record and deletion when Continue changes the source", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:missing-refreshed";
    createLink(sessionKey, "claude", database);
    let scan = 0;
    const check = vi.fn(async () => {
      scan += 1;
      if (scan === 3) {
        upsertSessionUpstreamLink(
          {
            sessionKey,
            agentId: "main",
            catalogId: "claude",
            hostId: "gateway:local",
            threadId: "thread-refreshed",
            upstreamKind: "claude-cli",
            upstreamRef: { source: "refreshed" },
            marker: { offset: 999 },
          },
          { ...database, now: 7_777 },
        );
      }
      return [{ kind: "missing" as const, sessionKey }];
    });
    const options = {
      ...database,
      providers: [provider("claude", check)],
      loadEntry: () => ({ sessionId: "session-missing-refreshed" }) as never,
      loadOwnRecentUserTexts: async () => [],
    };
    const missingCounts = createMissingCounts();

    await runSessionUpstreamMonitorTick(options, missingCounts);
    await runSessionUpstreamMonitorTick(options, missingCounts);
    await runSessionUpstreamMonitorTick(options, missingCounts);

    expect(listSessionStateEventsSince(sessionKey, "main", 0, 20, database).events).toEqual([]);
    expect(readSessionUpstreamLink(sessionKey, "main", database)).toEqual(
      expect.objectContaining({ threadId: "thread-refreshed", marker: { offset: 999 } }),
    );
    expect(missingCounts.size).toBe(0);
  });

  it("prunes missing counters when a link leaves the watched set", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:missing-pruned";
    createLink(sessionKey, "claude", database);
    const check = vi.fn(async () => [{ kind: "missing" as const, sessionKey }]);
    const options = {
      ...database,
      providers: [provider("claude", check)],
      loadEntry: () => ({ sessionId: "session-missing-pruned" }) as never,
      loadOwnRecentUserTexts: async () => [],
    };
    const missingCounts = createMissingCounts();

    await runSessionUpstreamMonitorTick(options, missingCounts);
    expect(missingCounts.size).toBe(1);
    deleteSessionUpstreamLink(sessionKey, "main", database);
    await runSessionUpstreamMonitorTick(options, missingCounts);

    expect(check).toHaveBeenCalledOnce();
    expect(missingCounts.size).toBe(0);
  });

  it("clamps skewed upstream event times without touching bookkeeping clocks", async () => {
    const database = createDatabaseOptions();
    const watched = "agent:main:adopted:clamped";
    createLink(watched, "claude", database);
    const now = 100 * 24 * 60 * 60_000;
    const ancient = 1_000; // far beyond the 24h clamp window
    const claude = provider("claude", async (probes: SessionUpstreamProbe[]) =>
      probes.map((probe) => ({
        kind: "activity" as const,
        sessionKey: probe.sessionKey,
        occurredAt: ancient,
        humanTurns: 1,
        nextMarker: { offset: 4 },
        dedupeId: "4",
      })),
    );

    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [claude],
      now: () => now,
      loadEntry: vi.fn(() => ({ sessionId: "session-clamped" }) as never),
      loadOwnRecentUserTexts: async () => [],
    });

    const events = listSessionStateEventsSince(watched, "main", 0, 20, database).events;
    expect(events).toHaveLength(1);
    // Event time is clamped into [now - 24h, now]; cursor rows keep the local clock
    // so a skewed upstream timestamp cannot age watch state into retention pruning.
    expect(events[0]?.occurredAt).toBe(now - 24 * 60 * 60_000);
    const cursor = openOpenClawStateDatabase(database)
      .db.prepare("SELECT updated_at FROM session_watch_cursors WHERE target_session_key = ?")
      .get(watched) as { updated_at: number };
    expect(cursor.updated_at).toBe(now);
  });

  it("skips recording and marker writes when the link was refreshed mid-scan", async () => {
    const database = createDatabaseOptions();
    const watched = "agent:main:adopted:refreshed";
    createLink(watched, "claude", database);
    const claude = provider("claude", async (probes: SessionUpstreamProbe[]) => {
      // Simulate a Continue refreshing the link while the scan is in flight.
      upsertSessionUpstreamLink(
        {
          sessionKey: watched,
          agentId: "main",
          catalogId: "claude",
          hostId: "gateway:local",
          threadId: "thread-refreshed",
          upstreamKind: "claude-cli",
          upstreamRef: { source: "refreshed" },
          marker: { offset: 999 },
        },
        { ...database, now: 7_777 },
      );
      return probes.map((probe) => ({
        kind: "activity" as const,
        sessionKey: probe.sessionKey,
        occurredAt: 2_000,
        humanTurns: 1,
        nextMarker: { offset: 8 },
        dedupeId: "stale-8",
      }));
    });

    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [claude],
      now: () => 3_000,
      loadEntry: vi.fn(() => ({ sessionId: "session-refreshed" }) as never),
      loadOwnRecentUserTexts: async () => [],
    });

    expect(listSessionStateEventsSince(watched, "main", 0, 20, database).events).toHaveLength(0);
    const row = openOpenClawStateDatabase(database)
      .db.prepare("SELECT last_marker_json FROM session_upstream_links WHERE session_key = ?")
      .get(watched) as { last_marker_json: string };
    expect(JSON.parse(row.last_marker_json)).toEqual({ offset: 999 });
  });

  it("isolates a session-entry load failure to that link", async () => {
    const database = createDatabaseOptions();
    const broken = "agent:main:adopted:broken";
    const healthy = "agent:main:adopted:healthy";
    createLink(broken, "claude", database);
    createLink(healthy, "claude", database);
    const claude = provider("claude", async (probes: SessionUpstreamProbe[]) =>
      probes.map((probe) => ({
        kind: "activity" as const,
        sessionKey: probe.sessionKey,
        occurredAt: 2_500,
        humanTurns: 1,
        nextMarker: { offset: 6 },
        dedupeId: "6",
      })),
    );

    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [claude],
      now: () => 3_000,
      loadEntry: vi.fn(({ sessionKey }: { sessionKey: string }) => {
        if (sessionKey === broken) {
          throw new Error("corrupt session store");
        }
        return { sessionId: "session-healthy" } as never;
      }) as never,
      loadOwnRecentUserTexts: async () => [],
    });

    expect(listSessionStateEventsSince(broken, "main", 0, 20, database).events).toHaveLength(0);
    expect(listSessionStateEventsSince(healthy, "main", 0, 20, database).events).toHaveLength(1);
  });

  it("preserves a coalesced upstream burst count in the event payload", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:burst";
    createLink(sessionKey, "codex", database);

    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [
        provider("codex", async () => [
          {
            kind: "activity" as const,
            sessionKey,
            occurredAt: 2_000,
            humanTurns: 3,
            nextMarker: { turnId: "turn-3", userMessageCount: 1 },
            dedupeId: "turn-3:1",
          },
        ]),
      ],
      loadEntry: () => ({ sessionId: "session-burst" }) as never,
      loadOwnRecentUserTexts: async () => [],
    });

    expect(listSessionStateEventsSince(sessionKey, "main", 0, 20, database).events).toEqual([
      expect.objectContaining({
        kind: "human_direct_message",
        payload: { turns: 3 },
      }),
    ]);
  });

  it("isolates provider failures", async () => {
    const database = createDatabaseOptions();
    const codexSession = "agent:main:adopted:codex";
    createLink("agent:main:adopted:claude", "claude", database);
    createLink(codexSession, "codex", database);
    const codexCheck = vi.fn(async () => [
      {
        kind: "activity" as const,
        sessionKey: codexSession,
        occurredAt: 5_000,
        humanTurns: 1,
        nextMarker: { turnId: "turn-2" },
        dedupeId: "turn-2",
      },
    ]);

    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [
        provider("claude", async () => {
          throw new Error("broken");
        }),
        provider("codex", codexCheck),
      ],
      loadEntry: () => ({ sessionId: "session" }) as never,
      loadOwnRecentUserTexts: async () => [],
    });

    expect(codexCheck).toHaveBeenCalledOnce();
    expect(listSessionStateEventsSince(codexSession, "main", 0, 20, database).events).toHaveLength(
      1,
    );
  });

  it("defers active runs without advancing their marker", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:active";
    createLink(sessionKey, "claude", database);
    const check = vi.fn(async (_probes: SessionUpstreamProbe[]) => []);
    const claude = provider("claude", check);

    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [claude],
      loadEntry: () => ({ sessionId: "session-active" }) as never,
      isRunActive: () => true,
      loadOwnRecentUserTexts: async () => [],
    });
    expect(check).not.toHaveBeenCalled();

    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [claude],
      loadEntry: () => ({ sessionId: "session-active" }) as never,
      isRunActive: () => false,
      loadOwnRecentUserTexts: async () => [],
    });

    expect(check).toHaveBeenCalledWith([expect.objectContaining({ marker: { offset: 0 } })]);
  });

  it("defers activity when a run starts during the provider scan", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:active-race";
    createLink(sessionKey, "claude", database);
    let active = false;
    const check = vi.fn(async (_probes: SessionUpstreamProbe[]) => {
      active = true;
      return [
        {
          kind: "activity" as const,
          sessionKey,
          occurredAt: 2_000,
          humanTurns: 1,
          nextMarker: { offset: 12 },
          dedupeId: "12",
        },
      ];
    });

    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [provider("claude", check)],
      loadEntry: () => ({ sessionId: "session-active-race" }) as never,
      isRunActive: () => active,
      loadOwnRecentUserTexts: async () => [],
    });
    active = false;
    check.mockResolvedValueOnce([]);
    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [provider("claude", check)],
      loadEntry: () => ({ sessionId: "session-active-race" }) as never,
      isRunActive: () => active,
      loadOwnRecentUserTexts: async () => [],
    });

    expect(check.mock.calls[1]?.[0]).toEqual([expect.objectContaining({ marker: { offset: 0 } })]);
    expect(listSessionStateEventsSince(sessionKey, "main", 0, 20, database).events).toEqual([]);
  });

  it("advances scan-only markers without recording an event", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:scan-only";
    createLink(sessionKey, "claude", database);
    const check = vi
      .fn<NonNullable<SessionCatalogProvider["checkUpstreamActivity"]>>()
      .mockResolvedValueOnce([
        { kind: "activity" as const, sessionKey, humanTurns: 0, nextMarker: { offset: 12 } },
      ])
      .mockResolvedValueOnce([]);

    const options = {
      ...database,
      providers: [provider("claude", check)],
      loadEntry: () => ({ sessionId: "session-scan" }) as never,
      loadOwnRecentUserTexts: async () => [],
    };
    await runSessionUpstreamMonitorTick(options);
    await runSessionUpstreamMonitorTick(options);

    expect(check.mock.calls[1]?.[0]).toEqual([expect.objectContaining({ marker: { offset: 12 } })]);
    expect(listSessionStateEventsSince(sessionKey, "main", 0, 20, database).events).toEqual([]);
  });

  it("supplies provenance text so a matching upstream prompt advances without an event", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:provenance";
    const sessionId = "session-provenance";
    await upsertSessionEntry(
      { agentId: "main", sessionKey, env: database.env },
      { sessionId, updatedAt: 1 },
    );
    await appendTranscriptMessage(
      { agentId: "main", sessionId, sessionKey, env: database.env },
      {
        cwd: process.cwd(),
        eventId: "user-message",
        message: {
          role: "user",
          content: "visible prompt",
          __openclaw: {
            mirrorOrigin: "codex-app-server",
            upstreamUserText: " exact   decorated prompt ",
          },
        },
      },
    );
    createLink(sessionKey, "claude", database);
    const check = vi.fn(async (probes: SessionUpstreamProbe[]) => [
      {
        kind: "activity" as const,
        sessionKey,
        humanTurns: probes[0]?.ownRecentUserTexts.includes("exact decorated prompt") ? 0 : 1,
        nextMarker: { offset: 20 },
      },
    ]);

    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [provider("claude", check)],
      isRunActive: () => false,
    });

    expect(check).toHaveBeenCalledWith([
      expect.objectContaining({ ownRecentUserTexts: ["exact decorated prompt"] }),
    ]);
    expect(listSessionStateEventsSince(sessionKey, "main", 0, 20, database).events).toEqual([]);
  });

  it("records an external prompt five seconds after OpenClaw activity", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:recent-external";
    createLink(sessionKey, "claude", database);

    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [
        provider("claude", async () => [
          {
            kind: "activity" as const,
            sessionKey,
            occurredAt: 10_000,
            humanTurns: 1,
            nextMarker: { offset: 24 },
            dedupeId: "24",
          },
        ]),
      ],
      loadEntry: () => ({ sessionId: "session-external", lastActivityAt: 5_000 }) as never,
      isRunActive: () => false,
      loadOwnRecentUserTexts: async () => ["OpenClaw prompt"],
    });

    expect(listSessionStateEventsSince(sessionKey, "main", 0, 20, database).events).toHaveLength(1);
  });
});
