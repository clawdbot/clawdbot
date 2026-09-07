import fsSync from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { expect, test, vi } from "vitest";
import * as sessionDirs from "../agents/session-dirs.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import * as agentDatabaseRegistry from "../state/openclaw-agent-db-registry.js";
import { withEnvAsync } from "../test-utils/env.js";
import { rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

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

test.runIf(process.platform !== "win32")(
  "requested-agent path projection collapses physical store aliases",
  async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required for gateway session tests");
    }
    const aliasStateDir = `${stateDir}-alias`;
    fsSync.symlinkSync(stateDir, aliasStateDir, "dir");
    try {
      const realStore = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      const aliasTemplate = path.join(
        aliasStateDir,
        "agents",
        "{agentId}",
        "sessions",
        "sessions.json",
      );
      await writeSessionStore({
        agentId: "main",
        entries: {
          "agent:main:main": { sessionId: "alias-main", updatedAt: 10 },
        },
        storePath: realStore,
      });
      testState.sessionConfig = { store: aliasTemplate };
      testState.agentsConfig = { list: [{ id: "main", default: true }] };

      const listed = await directSessionReq<{
        path: string;
        sessions: Array<{ key: string }>;
      }>("sessions.list", {
        agentId: "main",
      });

      expect(listed).toMatchObject({
        ok: true,
        payload: {
          path: resolveSqliteTargetFromSessionStorePath(realStore, { agentId: "main" }).path,
          sessions: [expect.objectContaining({ key: "agent:main:main" })],
        },
      });
    } finally {
      fsSync.rmSync(aliasStateDir, { force: true });
    }
  },
);

test("configured-only multi-store target preparation is reused across distinct lists", async () => {
  const rootStateDir = process.env.OPENCLAW_STATE_DIR;
  if (!rootStateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required for gateway session tests");
  }
  const stateDir = path.join(rootStateDir, "configured-path-scaling");
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    const agentIds = Array.from({ length: 29 }, (_, index) => `agent-${index}`);
    const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json");
    testState.sessionConfig = { store: storeTemplate };
    testState.agentsConfig = { list: agentIds.map((id, index) => ({ id, default: index === 0 })) };
    for (const agentId of agentIds) {
      const storePath = storeTemplate.replace("{agentId}", agentId);
      await writeSessionStore({
        agentId,
        entries: {
          [`agent:${agentId}:main`]: { sessionId: `session-${agentId}`, updatedAt: 10 },
        },
        storePath,
      });
    }

    const matcher = vi.spyOn(agentDatabaseRegistry, "createOpenClawAgentDatabasePathMatcher");
    const lstat = vi.spyOn(fsSync, "lstatSync");
    const readlink = vi.spyOn(fsSync, "readlinkSync");
    const realpath = vi.spyOn(fsSync.realpathSync, "native");
    const stat = vi.spyOn(fsSync, "statSync");
    syncBuiltinESMExports();
    try {
      const first = await directSessionReq<{ path: string }>("sessions.list", {
        configuredAgentsOnly: true,
        includeGlobal: false,
      });
      expect(first).toMatchObject({ ok: true, payload: { path: "(multiple)" } });
      expect(matcher).toHaveBeenCalledTimes(1);
      expect({
        realpath: realpath.mock.calls.length,
        stat: stat.mock.calls.length,
      }).toEqual({ realpath: agentIds.length, stat: agentIds.length });

      for (const spy of [matcher, lstat, readlink, realpath, stat]) {
        spy.mockClear();
      }
      const second = await directSessionReq<{ path: string }>("sessions.list", {
        configuredAgentsOnly: true,
        includeUnknown: false,
      });

      expect(second).toMatchObject({ ok: true, payload: { path: "(multiple)" } });
      expect({
        lstat: lstat.mock.calls.length,
        matcher: matcher.mock.calls.length,
        readlink: readlink.mock.calls.length,
        realpath: realpath.mock.calls.length,
        stat: stat.mock.calls.length,
      }).toEqual({ lstat: 0, matcher: 0, readlink: 0, realpath: 0, stat: 0 });
    } finally {
      matcher.mockRestore();
      lstat.mockRestore();
      readlink.mockRestore();
      realpath.mockRestore();
      stat.mockRestore();
      syncBuiltinESMExports();
    }
  });
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

test("filters sessions by agentId", async () => {
  const { dir } = await createSessionStoreDir();
  testState.sessionStorePath = undefined;
  testState.sessionConfig = {
    store: path.join(dir, "{agentId}", "sessions.json"),
  };
  testState.agentsConfig = {
    list: [{ id: "home", default: true }, { id: "work" }],
  };
  const homeDir = path.join(dir, "home");
  const workDir = path.join(dir, "work");
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(workDir, { recursive: true });
  await writeSessionStore({
    storePath: path.join(homeDir, "sessions.json"),
    agentId: "home",
    entries: {
      main: {
        sessionId: "sess-home-main",
        updatedAt: Date.now(),
      },
      "discord:group:dev": {
        sessionId: "sess-home-group",
        updatedAt: Date.now() - 1000,
      },
    },
  });
  await writeSessionStore({
    storePath: path.join(workDir, "sessions.json"),
    agentId: "work",
    entries: {
      main: {
        sessionId: "sess-work-main",
        updatedAt: Date.now(),
      },
    },
  });

  const { ws } = await openClient();
  try {
    const homeSessions = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      agentId: "home",
    });
    expect(homeSessions.ok).toBe(true);
    expect(homeSessions.payload?.sessions.map((s) => s.key).toSorted()).toEqual([
      "agent:home:discord:group:dev",
      "agent:home:main",
    ]);

    const workSessions = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      agentId: "work",
    });
    expect(workSessions.ok).toBe(true);
    expect(workSessions.payload?.sessions.map((s) => s.key)).toEqual(["agent:work:main"]);
  } finally {
    ws.close();
  }
});

test("resolves and patches main alias to default agent main key", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "ops", default: true }] };
  testState.sessionConfig = { mainKey: "work" };

  await writeSessionStore({
    storePath,
    agentId: "ops",
    mainKey: "work",
    entries: {
      main: {
        sessionId: "sess-ops-main",
        updatedAt: Date.now(),
      },
    },
  });

  const { ws } = await openClient();
  try {
    const resolved = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
      key: "main",
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.payload?.key).toBe("agent:ops:work");

    const patched = await rpcReq<{ ok: true; key: string }>(ws, "sessions.patch", {
      key: "main",
      thinkingLevel: "medium",
    });
    expect(patched.ok).toBe(true);
    expect(patched.payload?.key).toBe("agent:ops:work");

    expect(
      loadSessionEntry({ agentId: "ops", sessionKey: "agent:ops:work", storePath })?.thinkingLevel,
    ).toBe("medium");
    expect(loadSessionEntry({ agentId: "ops", sessionKey: "main", storePath })).toBeUndefined();
  } finally {
    ws.close();
  }
});
