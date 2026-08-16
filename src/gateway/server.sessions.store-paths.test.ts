import path from "node:path";
import { expect, test, vi } from "vitest";
import * as sessionDirs from "../agents/session-dirs.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { withEnvAsync } from "../test-utils/env.js";
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

test("configured-only parent-owned stores keep lineage children without directory discovery", async () => {
  const rootStateDir = process.env.OPENCLAW_STATE_DIR;
  if (!rootStateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required for gateway session tests");
  }
  const stateDir = path.join(rootStateDir, "fixed-configured-list-regression");
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json");
    const storePath = storeTemplate.replace("{agentId}", "ops");
    const mainKey = "agent:ops:main";
    const childKey = "agent:codex:subagent:fixed-child";
    testState.sessionConfig = { store: storeTemplate };
    testState.agentsConfig = { ownership: "explicit", list: [{ id: "ops" }] };
    testState.agentConfig = { sessionStore: { agentId: "ops" } };
    await writeSessionStore({
      agentId: "ops",
      storePath,
      entries: {
        [childKey]: { sessionId: "session-child", updatedAt: 30, parentSessionKey: mainKey },
        [mainKey]: { sessionId: "session-main", updatedAt: 20 },
        "agent:local:main": { sessionId: "session-local", updatedAt: 10 },
      },
    });

    const enumerateAgentDirs = vi.spyOn(sessionDirs, "resolveAgentSessionDirsFromAgentsDirSync");
    try {
      const listed = await directSessionReq<{ sessions: Array<{ key: string }> }>("sessions.list", {
        includeGlobal: false,
        includeUnknown: false,
        configuredAgentsOnly: true,
      });

      expect(listed.ok).toBe(true);
      expect(listed.payload?.sessions.map((session) => session.key)).toEqual([childKey, mainKey]);
      expect(enumerateAgentDirs).not.toHaveBeenCalled();
    } finally {
      enumerateAgentDirs.mockRestore();
    }
  });
});
