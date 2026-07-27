/**
 * Sharing resolution runs per row, and each call materialized a whole session
 * lookup store. That made `sessions.list` quadratic in entries even after
 * connection reuse removed the per-row SQLite opens.
 */
import { expect, test, vi } from "vitest";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

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
  // `listSessionEntries`; the listing itself and ACP metadata use the read-only
  // variant, so this isolates the per-row store loads under test.
  const original = sessionAccessor.listSessionEntries;
  const spies = [
    vi.spyOn(sessionAccessor, "listSessionEntries").mockImplementation(((...args: never[]) => {
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
  database.db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
    JSON.stringify({
      ...(JSON.parse(stored.entry_json) as Record<string, unknown>),
      skillsSnapshot: { prompt: "large skill prompt", skills: [{ name: "test" }] },
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        systemPrompt: { chars: 100, projectContextChars: 40, nonProjectContextChars: 60 },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
      },
    }),
    stored.session_key,
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
  const originalWritable = sessionAccessor.listSessionEntries;
  const spies = [
    vi.spyOn(sessionAccessor, "listSessionEntriesReadOnly").mockImplementation((scope) => {
      projections.push(scope?.projection);
      return originalReadOnly(scope);
    }),
    vi.spyOn(sessionAccessor, "listSessionEntries").mockImplementation((scope) => {
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
