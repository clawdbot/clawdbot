import { afterEach, expect, test } from "vitest";
import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
  writeSingleLineSession,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

test("sessions.delete removes the session board from its agent database", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-board", "hello");
  await writeSessionStore({
    entries: {
      "discord:group:board-delete": sessionStoreEntry("sess-board"),
    },
  });
  const sessionKey = "agent:main:discord:group:board-delete";
  if (!testState.sessionStorePath) {
    throw new Error("expected gateway session store path");
  }
  const databasePath = resolveSqliteTargetFromSessionStorePath(testState.sessionStorePath, {
    agentId: "main",
  }).path;
  if (!databasePath) {
    throw new Error("expected gateway agent database path");
  }
  const store = new SqliteBoardStore({
    resolveSession: () => ({
      agentId: "main",
      path: databasePath,
      sessionKey,
    }),
    env: process.env,
  });
  store.putWidget({
    sessionKey,
    name: "status",
    content: { kind: "html", html: "ok" },
  });

  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
    key: "discord:group:board-delete",
  });

  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(true);
  expect(store.getSnapshot(sessionKey)).toEqual({
    sessionKey,
    revision: 0,
    tabs: [],
    widgets: [],
  });
});
