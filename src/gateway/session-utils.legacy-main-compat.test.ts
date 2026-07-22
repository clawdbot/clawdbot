import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { importSqliteSessionRows } from "../config/sessions/session-accessor.sqlite.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  resolveGatewaySessionStoreTargetWithStore,
  resolveSessionStoreKey,
} from "./session-utils.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

test("legacy main rows in the default agent store resolve to that database", () => {
  const cfg = {
    session: { mainKey: "work" },
    agents: { list: [{ id: "ops", default: true }, { id: "worker" }] },
  } as OpenClawConfig;

  expect(
    resolveSessionStoreKey({
      cfg,
      sessionKey: "agent:main:work",
      storeAgentId: "ops",
    }),
  ).toBe("agent:ops:work");
  expect(
    resolveSessionStoreKey({
      cfg,
      sessionKey: "agent:main:work",
      storeAgentId: "worker",
    }),
  ).toBe("agent:main:work");
});

test("gateway keeps an observed deleted-main store reachable for a non-main default", async () => {
  const stateDir = tempDirs.make("openclaw-gateway-legacy-main-");
  const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json");
  const cfg = {
    agents: { list: [{ id: "ops", default: true }] },
    session: { store: storeTemplate },
  } satisfies OpenClawConfig;
  const legacyStorePath = resolveStorePath(storeTemplate, { agentId: "main" });
  await importSqliteSessionRows({
    agentId: "main",
    sessionKey: "agent:main:main",
    storePath: legacyStorePath,
    entry: { sessionId: "legacy-main", updatedAt: 10 },
  });

  const target = resolveGatewaySessionStoreTargetWithStore({
    cfg,
    key: "agent:main:main",
  });

  expect(target.agentId).toBe("main");
  expect(target.storePath).toBe(legacyStorePath);
  expect(target.canonicalKey).toBe("agent:ops:main");
  expect(target.store["agent:main:main"]?.sessionId).toBe("legacy-main");
});

test("gateway discovers a legacy main store after the configured store path changes", async () => {
  const stateDir = tempDirs.make("openclaw-gateway-moved-main-store-");
  const legacyStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  await importSqliteSessionRows({
    agentId: "main",
    sessionKey: "agent:main:main",
    storePath: legacyStorePath,
    entry: { sessionId: "legacy-main", updatedAt: 10 },
  });
  const cfg = {
    agents: { list: [{ id: "ops", default: true }] },
    session: { store: path.join(stateDir, "current", "{agentId}.json") },
  } satisfies OpenClawConfig;

  const target = await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () =>
    resolveGatewaySessionStoreTargetWithStore({ cfg, key: "agent:main:main" }),
  );

  expect(target.canonicalKey).toBe("agent:ops:main");
  expect(target.storePath).toBe(legacyStorePath);
  expect(target.store["agent:main:main"]?.sessionId).toBe("legacy-main");
});

test("gateway does not reinterpret non-main keys from a deleted main store", async () => {
  const stateDir = tempDirs.make("openclaw-gateway-non-main-key-");
  const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json");
  const cfg = {
    agents: { list: [{ id: "ops", default: true }] },
    session: { store: storeTemplate },
  } satisfies OpenClawConfig;
  const legacyStorePath = resolveStorePath(storeTemplate, { agentId: "main" });
  await importSqliteSessionRows({
    agentId: "main",
    sessionKey: "agent:main:main",
    storePath: legacyStorePath,
    entry: { sessionId: "legacy-main", updatedAt: 10 },
  });

  const target = resolveGatewaySessionStoreTargetWithStore({
    cfg,
    key: "agent:main:subagent:missing",
  });

  expect(target.canonicalKey).toBe("agent:main:subagent:missing");
  expect(target.storeKeys).not.toContain("agent:main:main");
});

test("gateway prefers an existing canonical default session over a stale legacy alias", async () => {
  const stateDir = tempDirs.make("openclaw-gateway-canonical-main-");
  const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json");
  const cfg = {
    agents: { list: [{ id: "ops", default: true }] },
    session: { store: storeTemplate },
  } satisfies OpenClawConfig;
  const legacyStorePath = resolveStorePath(storeTemplate, { agentId: "main" });
  const defaultStorePath = resolveStorePath(storeTemplate, { agentId: "ops" });
  await importSqliteSessionRows({
    agentId: "main",
    sessionKey: "agent:main:main",
    storePath: legacyStorePath,
    entry: { sessionId: "stale-legacy", updatedAt: 10 },
  });
  await importSqliteSessionRows({
    agentId: "ops",
    sessionKey: "agent:ops:main",
    storePath: defaultStorePath,
    entry: { sessionId: "canonical", updatedAt: 20 },
  });

  const target = resolveGatewaySessionStoreTargetWithStore({ cfg, key: "main" });

  expect(target.agentId).toBe("ops");
  expect(target.storePath).toBe(defaultStorePath);
  expect(target.store[target.canonicalKey]?.sessionId).toBe("canonical");
});

test("gateway honors an explicit non-default agent before legacy fallback", async () => {
  const stateDir = tempDirs.make("openclaw-gateway-explicit-agent-");
  const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json");
  const cfg = {
    agents: { list: [{ id: "ops", default: true }, { id: "worker" }] },
    session: { store: storeTemplate },
  } satisfies OpenClawConfig;
  const legacyStorePath = resolveStorePath(storeTemplate, { agentId: "main" });
  const workerStorePath = resolveStorePath(storeTemplate, { agentId: "worker" });
  await importSqliteSessionRows({
    agentId: "main",
    sessionKey: "agent:main:main",
    storePath: legacyStorePath,
    entry: { sessionId: "legacy-main", updatedAt: 20 },
  });
  await importSqliteSessionRows({
    agentId: "worker",
    sessionKey: "agent:worker:main",
    storePath: workerStorePath,
    entry: { sessionId: "worker", updatedAt: 10 },
  });

  const target = resolveGatewaySessionStoreTargetWithStore({
    cfg,
    key: "main",
    agentId: "worker",
  });

  expect(target.agentId).toBe("worker");
  expect(target.storePath).toBe(workerStorePath);
  expect(target.store[target.canonicalKey]?.sessionId).toBe("worker");
});

test("gateway lookup does not create a missing retired-main database", () => {
  const stateDir = tempDirs.make("openclaw-gateway-missing-main-");
  const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json");
  const cfg = {
    agents: { list: [{ id: "ops", default: true }] },
    session: { store: storeTemplate },
  } satisfies OpenClawConfig;
  const legacyStorePath = resolveStorePath(storeTemplate, { agentId: "main" });
  const legacySqlitePath = resolveSqliteTargetFromSessionStorePath(legacyStorePath, {
    agentId: "main",
  }).path;

  resolveGatewaySessionStoreTargetWithStore({ cfg, key: "main" });

  expect(fs.existsSync(legacySqlitePath)).toBe(false);
});
