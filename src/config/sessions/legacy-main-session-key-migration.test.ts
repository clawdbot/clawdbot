import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  ensureLegacyDefaultMainSessionKeysMigrated,
  migrateLegacyDefaultMainSessionKeys,
  resetLegacyDefaultMainSessionKeyMigrationForTest,
} from "./legacy-main-session-key-migration.js";
import { resolveStorePath } from "./paths.js";
import {
  loadExactSessionEntry,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "./session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { runSessionStartupMigration } from "./startup-migration.js";

const openDatabases = new Set<string>();

afterEach(() => {
  resetLegacyDefaultMainSessionKeyMigrationForTest();
  for (const databasePath of openDatabases) {
    closeOpenClawAgentDatabaseByPath(databasePath);
  }
  openDatabases.clear();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createFixture(prefix: string) {
  const root = tempDirs.make(prefix);
  return { root, env: { HOME: root, OPENCLAW_STATE_DIR: path.join(root, "state") } };
}

function trackStore(storePath: string, agentId: string): void {
  openDatabases.add(resolveSqliteTargetFromSessionStorePath(storePath, { agentId }).path);
}

async function seedSession(params: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  trackStore(params.storePath, params.agentId);
  await replaceSessionEntry(
    { agentId: params.agentId, storePath: params.storePath, sessionKey: params.sessionKey },
    { sessionId: params.sessionId, updatedAt: 10 },
  );
  await replaceTranscriptEvents(
    {
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    [
      { type: "session", sessionId: params.sessionId },
      { type: "custom", timestamp: "1970-01-01T00:00:00.010Z" },
    ],
  );
}

async function runAutomaticStartup(cfg: OpenClawConfig, env: NodeJS.ProcessEnv) {
  const log = { info: vi.fn(), warn: vi.fn() };
  await runSessionStartupMigration({
    cfg,
    env,
    log,
    deps: {
      migrateOrphanedSessionKeys: async () => ({ changes: [], warnings: [] }),
      resolveAllAgentSessionStoreTargetsSync: () => [],
      sweepOrphanSessionStoreTemps: async () => 0,
    },
  });
  return log;
}

async function expectCanonicalSession(params: {
  agentId: string;
  sessionId: string;
  storePath: string;
}): Promise<void> {
  const sessionKey = `agent:${params.agentId}:main`;
  expect(
    loadSessionEntry({ agentId: params.agentId, storePath: params.storePath, sessionKey }),
  ).toEqual(expect.objectContaining({ sessionId: params.sessionId }));
  await expect(
    loadTranscriptEvents({
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey,
      storePath: params.storePath,
    }),
  ).resolves.toHaveLength(2);
}

describe("legacy non-main default session key migration", () => {
  it("preserves continuity through normal startup for a fixed shared store", async () => {
    const { root, env } = createFixture("openclaw-main-key-shared-startup-");
    const storePath = path.join(root, "sessions.sqlite");
    const cfg = {
      agents: { list: [{ id: "ops", default: true }] },
      session: { store: storePath },
    } satisfies OpenClawConfig;
    await seedSession({
      agentId: "ops",
      sessionId: "shared-legacy",
      sessionKey: "agent:main:main",
      storePath,
    });

    const log = await runAutomaticStartup(cfg, env);

    await expectCanonicalSession({ agentId: "ops", sessionId: "shared-legacy", storePath });
    expect(
      loadExactSessionEntry({ agentId: "ops", storePath, sessionKey: "agent:main:main" }),
    ).toBeUndefined();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("legacy main-session keys"));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("preserves continuity through normal startup from the separate legacy main store", async () => {
    const { env } = createFixture("openclaw-main-key-separate-startup-");
    const cfg = { agents: { list: [{ id: "ops", default: true }] } } satisfies OpenClawConfig;
    const legacyStorePath = resolveStorePath(undefined, { agentId: "main", env });
    const defaultStorePath = resolveStorePath(undefined, { agentId: "ops", env });
    trackStore(defaultStorePath, "ops");
    await seedSession({
      agentId: "main",
      sessionId: "separate-legacy",
      sessionKey: "agent:main:main",
      storePath: legacyStorePath,
    });

    const log = await runAutomaticStartup(cfg, env);

    expect(log.warn.mock.calls).toEqual([]);
    expect(log.info.mock.calls).toEqual([[expect.stringContaining("legacy main-session keys")]]);
    expect(
      loadExactSessionEntry({
        agentId: "ops",
        storePath: defaultStorePath,
        sessionKey: "agent:ops:main",
      }),
    ).toBeDefined();
    await expectCanonicalSession({
      agentId: "ops",
      sessionId: "separate-legacy",
      storePath: defaultStorePath,
    });
    expect(
      loadExactSessionEntry({
        agentId: "main",
        storePath: legacyStorePath,
        sessionKey: "agent:main:main",
      }),
    ).toBeUndefined();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("legacy main-session keys"));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("keeps an existing canonical collision and emits a diagnostic", async () => {
    const { env } = createFixture("openclaw-main-key-collision-");
    const cfg = { agents: { list: [{ id: "ops", default: true }] } } satisfies OpenClawConfig;
    const legacyStorePath = resolveStorePath(undefined, { agentId: "main", env });
    const defaultStorePath = resolveStorePath(undefined, { agentId: "ops", env });
    await seedSession({
      agentId: "main",
      sessionId: "legacy",
      sessionKey: "agent:main:main",
      storePath: legacyStorePath,
    });
    await seedSession({
      agentId: "ops",
      sessionId: "canonical",
      sessionKey: "agent:ops:main",
      storePath: defaultStorePath,
    });

    const log = await runAutomaticStartup(cfg, env);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Kept existing agent:ops:main"));
    await expectCanonicalSession({
      agentId: "ops",
      sessionId: "canonical",
      storePath: defaultStorePath,
    });
    expect(
      loadExactSessionEntry({
        agentId: "main",
        storePath: legacyStorePath,
        sessionKey: "agent:main:main",
      }),
    ).toBeDefined();
  });

  it("is cached after the first automatic check but doctor can retry directly", async () => {
    const { env } = createFixture("openclaw-main-key-cache-");
    const cfg = { agents: { list: [{ id: "ops", default: true }] } } satisfies OpenClawConfig;
    await expect(ensureLegacyDefaultMainSessionKeysMigrated(cfg, env)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    await expect(ensureLegacyDefaultMainSessionKeysMigrated(cfg, env)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    await expect(migrateLegacyDefaultMainSessionKeys(cfg, env)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
  });

  it("requires one explicit default before assigning legacy ownership", async () => {
    await expect(
      migrateLegacyDefaultMainSessionKeys({
        agents: { list: [{ id: "ops" }, { id: "work" }] },
      }),
    ).resolves.toEqual({
      changes: [],
      warnings: [
        "Skipped legacy main-session key migration because the roster has no unique explicit default.",
      ],
    });
  });
});
