import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  ensureLegacyDefaultMainSessionKeysMigrated,
  migrateLegacyDefaultMainSessionKeys,
  readUnresolvedLegacyMainSessionCompat,
  resetLegacyDefaultMainSessionKeyMigrationForTest,
} from "./legacy-main-session-key-migration.js";
import { resolveStorePath } from "./paths.js";
import {
  loadExactSessionEntry,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceTranscriptEvents,
} from "./session-accessor.js";
import { importSqliteSessionRows } from "./session-accessor.sqlite.js";
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
  updatedAt?: number;
}): Promise<void> {
  trackStore(params.storePath, params.agentId);
  await importSqliteSessionRows({
    agentId: params.agentId,
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    entry: { sessionId: params.sessionId, updatedAt: params.updatedAt ?? 10 },
  });
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

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("both claim main"));
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
    expect(
      readUnresolvedLegacyMainSessionCompat({
        canonicalKey: "agent:ops:main",
        defaultAgentId: "ops",
      }),
    ).toMatchObject({ legacyKey: "agent:main:main", entry: { sessionId: "legacy" } });
  });

  it("removes a same-store alias when the canonical session identity is identical", async () => {
    const { root, env } = createFixture("openclaw-main-key-identical-");
    const storePath = path.join(root, "sessions.sqlite");
    const cfg = {
      agents: { list: [{ id: "ops", default: true }] },
      session: { store: storePath },
    } satisfies OpenClawConfig;
    await seedSession({
      agentId: "ops",
      sessionId: "same",
      sessionKey: "agent:ops:main",
      storePath,
    });
    await seedSession({
      agentId: "ops",
      sessionId: "same",
      sessionKey: "agent:main:main",
      storePath,
    });

    const result = await migrateLegacyDefaultMainSessionKeys(cfg, env);

    expect(result.outcomes).toEqual([
      expect.objectContaining({ kind: "canonical-exists-identical", resolved: true }),
    ]);
    expect(
      loadExactSessionEntry({ agentId: "ops", storePath, sessionKey: "agent:main:main" }),
    ).toBeUndefined();
    expect(
      loadExactSessionEntry({ agentId: "ops", storePath, sessionKey: "agent:ops:main" }),
    ).toBeDefined();
  });

  it("records disagreeing aliases and selects only their exact compat keys", async () => {
    const { root, env } = createFixture("openclaw-main-key-aliases-");
    const storePath = path.join(root, "sessions.sqlite");
    const cfg = {
      agents: { list: [{ id: "ops", default: true }] },
      session: { store: storePath, mainKey: "primary" },
    } satisfies OpenClawConfig;
    await seedSession({
      agentId: "ops",
      sessionId: "older",
      sessionKey: "agent:main:primary",
      storePath,
      updatedAt: 10,
    });
    await seedSession({
      agentId: "ops",
      sessionId: "newer",
      sessionKey: "agent:main:main",
      storePath,
      updatedAt: 20,
    });

    const result = await ensureLegacyDefaultMainSessionKeysMigrated(cfg, env);

    expect(result.outcomes).toEqual([
      expect.objectContaining({ kind: "aliases-disagree", resolved: false }),
    ]);
    expect(
      readUnresolvedLegacyMainSessionCompat({
        canonicalKey: "agent:ops:primary",
        defaultAgentId: "ops",
      }),
    ).toMatchObject({ legacyKey: "agent:main:main", entry: { sessionId: "newer" } });
    expect(
      readUnresolvedLegacyMainSessionCompat({
        canonicalKey: "agent:ops:unrelated",
        defaultAgentId: "ops",
      }),
    ).toBeUndefined();
  });

  it("records an unreadable store as an unresolved outcome", async () => {
    const { root, env } = createFixture("openclaw-main-key-unreadable-");
    const storePath = path.join(root, "sessions.sqlite");
    fs.writeFileSync(storePath, "not sqlite");
    const cfg = {
      agents: { list: [{ id: "ops", default: true }] },
      session: { store: storePath },
    } satisfies OpenClawConfig;

    const result = await ensureLegacyDefaultMainSessionKeysMigrated(cfg, env);

    expect(result.outcomes).toEqual([
      expect.objectContaining({
        kind: "store-unreadable",
        resolved: false,
        sourceStorePath: storePath,
      }),
    ]);
  });

  it("is cached after the first automatic check but doctor can retry directly", async () => {
    const { env } = createFixture("openclaw-main-key-cache-");
    const cfg = { agents: { list: [{ id: "ops", default: true }] } } satisfies OpenClawConfig;
    await expect(ensureLegacyDefaultMainSessionKeysMigrated(cfg, env)).resolves.toEqual({
      outcomes: [expect.objectContaining({ kind: "not-needed", resolved: true })],
    });
    await expect(ensureLegacyDefaultMainSessionKeysMigrated(cfg, env)).resolves.toEqual({
      outcomes: [],
    });
    await expect(migrateLegacyDefaultMainSessionKeys(cfg, env)).resolves.toEqual({
      outcomes: [expect.objectContaining({ kind: "not-needed", resolved: true })],
    });
  });

  it("requires one explicit default before assigning legacy ownership", async () => {
    await expect(
      migrateLegacyDefaultMainSessionKeys({
        agents: { list: [{ id: "ops" }, { id: "work" }] },
      }),
    ).resolves.toEqual({
      outcomes: [{ kind: "not-needed", resolved: true, reason: "no-target" }],
    });
  });
});
