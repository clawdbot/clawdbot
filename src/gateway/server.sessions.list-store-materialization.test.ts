/**
 * Sharing resolution runs per row, and each call materialized a whole session
 * lookup store. That made `sessions.list` quadratic in entries even after
 * connection reuse removed the per-row SQLite opens.
 */
import path from "node:path";
import { expect, test, vi } from "vitest";
import * as sessionsConfig from "../config/sessions.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { SessionEntry } from "../config/sessions/types.js";
import * as agentDatabaseRegistry from "../state/openclaw-agent-db-registry.js";
import {
  OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { scheduleGatewayHandlerPrewarm } from "./server-startup-handler-prewarm.js";
import type { SessionsListResult } from "./session-utils.types.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  seedSessionTranscript,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

const LIST_PARAMS = {
  agentId: "main",
  configuredAgentsOnly: true,
  includeDerivedTitles: true,
  includeGlobal: true,
  includeUnknown: true,
  limit: 100,
};

async function countMaterializedEntriesForRows(rows: number): Promise<number> {
  await createSessionStoreDir();
  const entries: Record<string, ReturnType<typeof sessionStoreEntry>> = {
    main: sessionStoreEntry("sess-main"),
  };
  for (let index = 0; index < rows; index++) {
    entries[`agent:main:row-${index}`] = sessionStoreEntry(`sess-row-${index}`, {
      updatedAt: 1_781_000_000_000 - index * 1_000,
    });
  }
  await writeSessionStore({ entries });
  // Warm lazily-initialized module state so only steady-state reads are counted.
  await directSessionReq("sessions.list", LIST_PARAMS);

  let materialized = 0;
  // Only the lookup-store path used by sharing resolution goes through
  // `listSessionEntriesCore`; the listing itself and ACP metadata use the read-only
  // variant, so this isolates the per-row store loads under test.
  const original = sessionAccessor.listSessionEntriesCore;
  const spies = [
    vi.spyOn(sessionAccessor, "listSessionEntriesCore").mockImplementation(((...args: never[]) => {
      const result = (original as (...inner: never[]) => unknown[])(...args);
      materialized += Array.isArray(result) ? result.length : 0;
      return result;
    }) as never),
  ];
  try {
    const result = await directSessionReq("sessions.list", LIST_PARAMS);
    expect(result.ok).toBe(true);
    return materialized;
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
}

test("sessions.list does not materialize the lookup store once per row", async () => {
  const small = await countMaterializedEntriesForRows(5);
  const large = await countMaterializedEntriesForRows(40);

  // The post-await sharing refresh intentionally rereads current ACL state,
  // but one request-scoped load per store keeps that refresh linear.
  expect(large).toBeLessThan(small * 12);
});

test("sessions.list reuses prepared store targets for sharing", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `agent:main:row-${index}`,
        sessionStoreEntry(`sess-row-${index}`),
      ]),
    ),
  });
  const discoverySpy = vi.spyOn(sessionsConfig, "resolveExistingAgentSessionStoreTargetsSync");
  try {
    const result = await directSessionReq("sessions.list", LIST_PARAMS);
    expect(result.ok).toBe(true);
    expect(discoverySpy.mock.calls.filter((call) => call[1] === "main")).toHaveLength(0);
  } finally {
    discoverySpy.mockRestore();
  }
});

test("sessions.list keeps cold and warm transcript title batches valid beyond the database handle cap", async () => {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required for gateway session tests");
  }
  const agentIds = Array.from(
    { length: OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP + 1 },
    (_, index) => `batch-agent-${index}`,
  );
  const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json");
  testState.sessionConfig = { store: storeTemplate };
  testState.agentsConfig = {
    list: agentIds.map((id, index) => ({ id, default: index === 0 })),
  };

  for (const [index, agentId] of agentIds.entries()) {
    const sessionId = `session-${agentId}`;
    const sessionKey = `agent:${agentId}:main`;
    const storePath = storeTemplate.replace("{agentId}", agentId);
    await writeSessionStore({
      agentId,
      entries: {
        [sessionKey]: sessionStoreEntry(sessionId, { updatedAt: 1_781_000_000_000 - index }),
      },
      storePath,
    });
    await seedSessionTranscript({
      agentId,
      messages: [
        { role: "user", content: `Title ${agentId}` },
        { role: "assistant", content: `Reply ${agentId}` },
      ],
      sessionId,
      sessionKey,
      storePath,
    });
  }

  const watermarkBatchSpy = vi.spyOn(sessionAccessor, "readSessionTranscriptWatermarkBatch");
  try {
    for (const phase of ["cold", "warm"]) {
      const result = await directSessionReq<SessionsListResult>("sessions.list", {
        includeDerivedTitles: true,
        includeLastMessage: true,
        ...(phase === "warm" ? { limit: 100 } : {}),
      });

      expect(result.ok, `${phase} transcript title batch`).toBe(true);
      expect(result.payload?.sessions, `${phase} transcript title batch`).toHaveLength(
        agentIds.length,
      );
      expect(
        result.payload?.sessions.every(
          (session) =>
            session.derivedTitle?.startsWith("Title ") &&
            session.lastMessagePreview?.startsWith("Reply "),
        ),
        `${phase} transcript title batch`,
      ).toBe(true);
      if (phase === "warm") {
        expect(
          watermarkBatchSpy.mock.calls.some(([scopes]) => scopes.length === agentIds.length),
        ).toBe(true);
      }
      watermarkBatchSpy.mockClear();
    }
  } finally {
    watermarkBatchSpy.mockRestore();
  }
});

test("startup prewarm reuses requested durable targets when no incognito store is open", async () => {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required for gateway session tests");
  }
  const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json");
  const storePath = storeTemplate.replace("{agentId}", "main");
  await writeSessionStore({
    entries: { main: sessionStoreEntry("sess-main") },
    storePath,
  });
  const matcher = vi.spyOn(agentDatabaseRegistry, "createOpenClawAgentDatabasePathMatcher");
  try {
    expect(
      sessionsConfig.canPrewarmCombinedSessionStoresForGateway(
        {
          agents: { list: [{ id: "main", default: true }] },
          session: { store: storeTemplate },
        },
        { agentIds: ["main"], maxRows: 10 },
      ),
    ).toBe(true);
    expect(matcher).toHaveBeenCalledTimes(1);
  } finally {
    matcher.mockRestore();
  }
});

test("startup prewarm fills session snapshot and title caches before the first list", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:warm-cache";
  const sessionId = "warm-cache";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId),
    },
  });
  await seedSessionTranscript({
    agentId: "main",
    messages: [
      { role: "user", content: "Warm title" },
      { role: "assistant", content: "Warm response" },
    ],
    sessionId,
    sessionKey,
    storePath,
  });
  const titleBatchSpy = vi.spyOn(sessionAccessor, "readSessionTranscriptTitleProbeBatch");
  const titlePageSpy = vi.spyOn(sessionAccessor, "readSessionTranscriptMessageEventPage");
  let sidecar: ReturnType<typeof scheduleGatewayHandlerPrewarm> | undefined;
  vi.useFakeTimers();
  try {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      session: { store: storePath },
    } as never;
    let resolveSessionPrewarm!: () => void;
    const sessionPrewarm = new Promise<void>((resolve) => {
      resolveSessionPrewarm = resolve;
    });
    sidecar = scheduleGatewayHandlerPrewarm({
      cfgAtStart: cfg,
      log: { warn: vi.fn() },
      startupTrace: {
        measure: async (name, run) => {
          try {
            return await run();
          } finally {
            if (name === "post-ready.gateway-data.sessions.main") {
              resolveSessionPrewarm();
            }
          }
        },
      },
    });
    await vi.advanceTimersToNextTimerAsync();
    await sessionPrewarm;
    await sidecar.stop();
    expect(titleBatchSpy).toHaveBeenCalled();
    expect(titlePageSpy).not.toHaveBeenCalled();
    titleBatchSpy.mockClear();
    titlePageSpy.mockClear();
    vi.useRealTimers();
    const cachedEntries = sessionAccessor.listSessionEntriesReadOnly({
      agentId: "main",
      clone: false,
      projection: "list",
      storePath,
    });

    const result = await directSessionReq<SessionsListResult>("sessions.list", {
      ...LIST_PARAMS,
      includeDerivedTitles: true,
    });

    expect(result.ok).toBe(true);
    expect(result.payload?.sessions).toContainEqual(
      expect.objectContaining({ key: sessionKey, derivedTitle: "Warm title" }),
    );
    expect(titleBatchSpy).not.toHaveBeenCalled();
    expect(titlePageSpy).not.toHaveBeenCalled();
    const afterListEntries = sessionAccessor.listSessionEntriesReadOnly({
      agentId: "main",
      clone: false,
      projection: "list",
      storePath,
    });
    expect(afterListEntries[0]?.entry).toBe(cachedEntries[0]?.entry);
  } finally {
    await sidecar?.stop();
    vi.useRealTimers();
    titleBatchSpy.mockRestore();
    titlePageSpy.mockRestore();
  }
});

test("startup skips a large session prewarm while request-time listing remains available", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: Object.fromEntries(
      Array.from({ length: 2_001 }, (_, index) => [
        `agent:main:large-${index}`,
        sessionStoreEntry(`large-${index}`, { updatedAt: 1_781_000_000_000 - index }),
      ]),
    ),
  });
  const info = vi.fn();
  const listSpy = vi.spyOn(sessionAccessor, "listSessionEntriesReadOnly");
  let sidecar: ReturnType<typeof scheduleGatewayHandlerPrewarm> | undefined;
  vi.useFakeTimers();
  try {
    let resolveSessionPrewarm!: () => void;
    const sessionPrewarm = new Promise<void>((resolve) => {
      resolveSessionPrewarm = resolve;
    });
    sidecar = scheduleGatewayHandlerPrewarm({
      cfgAtStart: {
        agents: { list: [{ id: "main", default: true }] },
        session: { store: storePath },
      } as never,
      log: { info, warn: vi.fn() },
      startupTrace: {
        measure: async (name, run) => {
          try {
            return await run();
          } finally {
            if (name === "post-ready.gateway-data.sessions.main") {
              resolveSessionPrewarm();
            }
          }
        },
      },
    });

    await vi.advanceTimersToNextTimerAsync();
    await sessionPrewarm;
    await sidecar.stop();
    expect(info).toHaveBeenCalledWith(
      "skipping optional dashboard session prewarm: combined stores exceed 2000 rows",
    );
    expect(listSpy).not.toHaveBeenCalled();

    vi.useRealTimers();
    const result = await directSessionReq("sessions.list", LIST_PARAMS);
    expect(result.ok).toBe(true);
  } finally {
    await sidecar?.stop();
    vi.useRealTimers();
    listSpy.mockRestore();
  }
});

test("sessions.list projects out prompt snapshots without changing full entry reads", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
    },
  });
  const storePath = testState.sessionStorePath!;
  const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
  const database = openOpenClawAgentDatabase({
    agentId: target.agentId ?? "main",
    path: target.path,
  });
  const stored = database.db
    .prepare("SELECT session_key, entry_json FROM session_nodes LIMIT 1")
    .get() as { session_key: string; entry_json: string };
  const storedEntry = JSON.parse(stored.entry_json) as SessionEntry;
  await sessionAccessor.replaceSessionEntry(
    { agentId: "main", sessionKey: stored.session_key, storePath },
    {
      ...storedEntry,
      skillsSnapshot: { prompt: "large skill prompt", skills: [{ name: "test" }] },
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        systemPrompt: { chars: 100, projectContextChars: 40, nonProjectContextChars: 60 },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
      },
    },
  );
  database.db
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run("zz-malformed", "malformed", "{", Date.now());

  const fullEntries = sessionAccessor.listSessionEntriesReadOnly({ agentId: "main", storePath });
  expect(fullEntries).toHaveLength(1);
  expect(fullEntries[0]?.entry.skillsSnapshot).toBeDefined();
  expect(fullEntries[0]?.entry.systemPromptReport?.source).toBe("run");

  const projections: Array<string | undefined> = [];
  const originalReadOnly = sessionAccessor.listSessionEntriesReadOnly;
  const originalWritable = sessionAccessor.listSessionEntriesCore;
  const spies = [
    vi.spyOn(sessionAccessor, "listSessionEntriesReadOnly").mockImplementation((scope) => {
      projections.push(scope?.projection);
      return originalReadOnly(scope);
    }),
    vi.spyOn(sessionAccessor, "listSessionEntriesCore").mockImplementation((scope) => {
      projections.push(scope?.projection);
      return originalWritable(scope);
    }),
  ];
  try {
    const result = await directSessionReq("sessions.list", LIST_PARAMS);
    expect(result.ok).toBe(true);
    expect(projections.length).toBeGreaterThan(0);
    expect(projections).toEqual(projections.map(() => "list"));
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }

  const listEntries = sessionAccessor.listSessionEntriesReadOnly({
    agentId: "main",
    projection: "list",
    storePath,
  });
  expect(listEntries).toHaveLength(1);
  expect(listEntries[0]?.entry.skillsSnapshot).toBeUndefined();
  expect(listEntries[0]?.entry.systemPromptReport).toBeUndefined();
});
