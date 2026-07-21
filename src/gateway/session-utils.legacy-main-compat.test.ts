import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  ensureLegacyDefaultMainSessionKeysMigrated,
  resetLegacyDefaultMainSessionKeyMigrationForTest,
} from "../config/sessions/legacy-main-session-key-migration.js";
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
