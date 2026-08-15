import path from "node:path";
import { expect, test } from "vitest";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

test("session RPC paths name the physical SQLite store", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { main: { sessionId: "session-main", updatedAt: 10 } },
  });
  const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
    agentId: "main",
  }).path;

  const listed = await directSessionReq<{ path: string }>("sessions.list", {});
  const patched = await directSessionReq<{ path: string }>("sessions.patch", {
    key: "agent:main:main",
    label: "Main",
  });

  expect(listed).toMatchObject({ ok: true, payload: { path: databasePath } });
  expect(patched).toMatchObject({ ok: true, payload: { path: databasePath } });
});

test("sessions.list reports multiple physical agent stores", async () => {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required for gateway session tests");
  }
  const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json");
  testState.sessionConfig = { store: storeTemplate };
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "ops" }] };
  for (const agentId of ["main", "ops"]) {
    await writeSessionStore({
      agentId,
      entries: {
        [`agent:${agentId}:main`]: { sessionId: `session-${agentId}`, updatedAt: 10 },
      },
      storePath: storeTemplate.replace("{agentId}", agentId),
    });
  }

  const listed = await directSessionReq<{ path: string }>("sessions.list", {});

  expect(listed).toMatchObject({ ok: true, payload: { path: "(multiple)" } });
});
