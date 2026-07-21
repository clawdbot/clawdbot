import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  ensureLegacyDefaultMainSessionKeysMigrated,
  resetLegacyDefaultMainSessionKeyMigrationForTest,
} from "../config/sessions/legacy-main-session-key-migration.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  appendTranscriptEvent,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { importSqliteSessionRows } from "../config/sessions/session-accessor.sqlite.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { resolveGatewaySessionStoreTargetWithStore } from "./session-utils.js";

afterEach(() => {
  resetLegacyDefaultMainSessionKeyMigrationForTest();
  closeOpenClawAgentDatabasesForTest();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

test("gateway reads only exact legacy keys recorded by an unresolved migration", async () => {
  const stateDir = tempDirs.make("openclaw-gateway-unresolved-main-");
  const storePath = path.join(stateDir, "shared.sqlite");
  const cfg = {
    agents: { list: [{ id: "ops", default: true }] },
    session: { mainKey: "primary", store: storePath },
  } satisfies OpenClawConfig;
  await importSqliteSessionRows({
    agentId: "ops",
    sessionKey: "agent:main:primary",
    storePath,
    entry: { sessionId: "older", updatedAt: 10 },
  });
  await importSqliteSessionRows({
    agentId: "ops",
    sessionKey: "agent:main:main",
    storePath,
    entry: { sessionId: "newer", updatedAt: 20 },
  });
  await ensureLegacyDefaultMainSessionKeysMigrated(cfg, {
    HOME: stateDir,
    OPENCLAW_STATE_DIR: stateDir,
  });

  const target = resolveGatewaySessionStoreTargetWithStore({ cfg, key: "main" });

  expect(target.canonicalKey).toBe("agent:ops:primary");
  expect(target.store[target.canonicalKey]?.sessionId).toBe("newer");
  expect(target.store["agent:ops:unrelated"]).toBeUndefined();
});

test("gateway keeps divergent cross-store history and subsequent writes together", async () => {
  const stateDir = tempDirs.make("openclaw-gateway-cross-store-main-");
  const env = { HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };
  const cfg = {
    agents: { list: [{ id: "ops", default: true }] },
    session: {
      mainKey: "primary",
      store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
    },
  } satisfies OpenClawConfig;
  const legacyStorePath = resolveStorePath(undefined, { agentId: "main", env });
  const defaultStorePath = resolveStorePath(undefined, { agentId: "ops", env });
  for (const [sessionKey, sessionId, updatedAt] of [
    ["agent:main:primary", "older", 10],
    ["agent:main:main", "newer", 20],
  ] as const) {
    await importSqliteSessionRows({
      agentId: "main",
      sessionKey,
      storePath: legacyStorePath,
      entry: { sessionId, updatedAt },
      readTranscriptEvents: (append) => {
        append({ type: "session", sessionId });
        append({ type: "custom", timestamp: "1970-01-01T00:00:00.010Z" });
      },
    });
  }
  await ensureLegacyDefaultMainSessionKeysMigrated(cfg, env);

  const target = resolveGatewaySessionStoreTargetWithStore({ cfg, key: "main" });
  expect(target.storePath).toBe(defaultStorePath);
  expect(target.canonicalKey).toBe("agent:ops:primary");
  expect(target.store[target.canonicalKey]?.sessionId).toBe("newer");

  await appendTranscriptEvent(
    {
      agentId: "ops",
      sessionId: "newer",
      sessionKey: target.canonicalKey,
      storePath: target.storePath,
    },
    { type: "custom", timestamp: "1970-01-01T00:00:00.030Z" },
  );
  await expect(
    loadTranscriptEvents({
      agentId: "ops",
      sessionId: "newer",
      sessionKey: target.canonicalKey,
      storePath: target.storePath,
    }),
  ).resolves.toHaveLength(3);
  await expect(
    loadTranscriptEvents({
      agentId: "main",
      sessionId: "newer",
      sessionKey: "agent:main:main",
      storePath: legacyStorePath,
    }),
  ).resolves.toHaveLength(2);
});
