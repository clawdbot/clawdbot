import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  formatLegacyMainSessionMigrationOutcome,
  migrateLegacyDefaultMainSessionKeys,
  type LegacyMainSessionKeyMigrationOutcome,
} from "./legacy-main-session-key-migration.js";
import { resolveStorePath } from "./paths.js";
import {
  loadExactSessionEntry,
  loadTranscriptEvents,
  replaceTranscriptEvents,
} from "./session-accessor.js";
import { importSqliteSessionRows } from "./session-accessor.sqlite.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import type { SessionEntry } from "./types.js";

const openDatabases = new Set<string>();

afterEach(() => {
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
  transcriptTimestamp?: string;
  updatedAt?: number;
  entry?: Partial<SessionEntry>;
}): Promise<void> {
  trackStore(params.storePath, params.agentId);
  await importSqliteSessionRows({
    agentId: params.agentId,
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    entry: {
      sessionId: params.sessionId,
      updatedAt: params.updatedAt ?? 10,
      ...params.entry,
    },
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
      { type: "custom", timestamp: params.transcriptTimestamp ?? "1970-01-01T00:00:00.010Z" },
    ],
  );
}

function outcomeOfKind<TKind extends LegacyMainSessionKeyMigrationOutcome["kind"]>(
  outcomes: LegacyMainSessionKeyMigrationOutcome[],
  kind: TKind,
): Extract<LegacyMainSessionKeyMigrationOutcome, { kind: TKind }> | undefined {
  return outcomes.find(
    (outcome): outcome is Extract<LegacyMainSessionKeyMigrationOutcome, { kind: TKind }> =>
      outcome.kind === kind,
  );
}

describe("legacy non-main default session key migration", () => {
  it("moves a separate legacy main store and its transcript to the configured default", async () => {
    const { env } = createFixture("openclaw-main-key-separate-");
    const cfg = {
      agents: { list: [{ id: "ops", default: true }] },
      session: { store: path.join(env.OPENCLAW_STATE_DIR!, "current", "{agentId}.json") },
    } satisfies OpenClawConfig;
    const legacyStorePath = resolveStorePath(undefined, { agentId: "main", env });
    const defaultStorePath = resolveStorePath(cfg.session.store, { agentId: "ops", env });
    trackStore(defaultStorePath, "ops");
    await seedSession({
      agentId: "main",
      sessionId: "separate-legacy",
      sessionKey: "agent:main:main",
      storePath: legacyStorePath,
    });

    const result = await migrateLegacyDefaultMainSessionKeys(cfg, env);

    expect(outcomeOfKind(result.outcomes, "migrated")).toBeDefined();
    expect(
      loadExactSessionEntry({
        agentId: "ops",
        storePath: defaultStorePath,
        sessionKey: "agent:ops:main",
      })?.entry,
    ).toMatchObject({ sessionId: "separate-legacy" });
    await expect(
      loadTranscriptEvents({
        agentId: "ops",
        sessionId: "separate-legacy",
        sessionKey: "agent:ops:main",
        storePath: defaultStorePath,
      }),
    ).resolves.toHaveLength(2);
    expect(
      loadExactSessionEntry({
        agentId: "main",
        storePath: legacyStorePath,
        sessionKey: "agent:main:main",
      }),
    ).toBeUndefined();
  });

  it("removes an identical same-store legacy alias", async () => {
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

    expect(outcomeOfKind(result.outcomes, "canonical-exists-identical")).toBeDefined();
    expect(
      loadExactSessionEntry({ agentId: "ops", storePath, sessionKey: "agent:main:main" }),
    ).toBeUndefined();
    expect(
      loadExactSessionEntry({ agentId: "ops", storePath, sessionKey: "agent:ops:main" }),
    ).toBeDefined();
  });

  it("keeps divergent canonical and legacy sessions unresolved", async () => {
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

    const result = await migrateLegacyDefaultMainSessionKeys(cfg, env);

    expect(outcomeOfKind(result.outcomes, "canonical-exists-different")).toBeDefined();
    expect(
      loadExactSessionEntry({
        agentId: "main",
        storePath: legacyStorePath,
        sessionKey: "agent:main:main",
      }),
    ).toBeDefined();
    expect(
      loadExactSessionEntry({
        agentId: "ops",
        storePath: defaultStorePath,
        sessionKey: "agent:ops:main",
      }),
    ).toBeDefined();
  });

  it("keeps matching session ids with divergent transcript history unresolved", async () => {
    const { env } = createFixture("openclaw-main-key-same-id-divergent-");
    const cfg = { agents: { list: [{ id: "ops", default: true }] } } satisfies OpenClawConfig;
    const legacyStorePath = resolveStorePath(undefined, { agentId: "main", env });
    const defaultStorePath = resolveStorePath(undefined, { agentId: "ops", env });
    await seedSession({
      agentId: "main",
      sessionId: "shared-id",
      sessionKey: "agent:main:main",
      storePath: legacyStorePath,
      transcriptTimestamp: "1970-01-01T00:00:00.010Z",
    });
    await seedSession({
      agentId: "ops",
      sessionId: "shared-id",
      sessionKey: "agent:ops:main",
      storePath: defaultStorePath,
      transcriptTimestamp: "1970-01-01T00:00:00.020Z",
    });

    const result = await migrateLegacyDefaultMainSessionKeys(cfg, env);
    const outcome = outcomeOfKind(result.outcomes, "canonical-exists-different");

    expect(outcome).toBeDefined();
    expect(formatLegacyMainSessionMigrationOutcome(outcome!)).toContain(legacyStorePath);
    expect(formatLegacyMainSessionMigrationOutcome(outcome!)).toContain(defaultStorePath);
    expect(
      loadExactSessionEntry({
        agentId: "main",
        storePath: legacyStorePath,
        sessionKey: "agent:main:main",
      }),
    ).toBeDefined();
  });

  it("keeps disagreeing same-store aliases unresolved", async () => {
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

    const result = await migrateLegacyDefaultMainSessionKeys(cfg, env);

    expect(outcomeOfKind(result.outcomes, "aliases-disagree")).toBeDefined();
    expect(
      loadExactSessionEntry({ agentId: "ops", storePath, sessionKey: "agent:main:primary" }),
    ).toBeDefined();
    expect(
      loadExactSessionEntry({ agentId: "ops", storePath, sessionKey: "agent:main:main" }),
    ).toBeDefined();
  });

  it("uses physical SQLite identity when one logical store derives per-agent databases", async () => {
    const { root, env } = createFixture("openclaw-main-key-shared-logical-");
    const storePath = path.join(root, "sessions.json");
    const cfg = {
      agents: { list: [{ id: "ops", default: true }] },
      session: { store: storePath },
    } satisfies OpenClawConfig;
    await seedSession({
      agentId: "main",
      sessionId: "legacy-shared-path",
      sessionKey: "agent:main:main",
      storePath,
    });

    const result = await migrateLegacyDefaultMainSessionKeys(cfg, env);

    expect(outcomeOfKind(result.outcomes, "migrated")).toBeDefined();
    expect(
      loadExactSessionEntry({ agentId: "ops", storePath, sessionKey: "agent:ops:main" })?.entry,
    ).toMatchObject({ sessionId: "legacy-shared-path" });
    expect(
      loadExactSessionEntry({ agentId: "main", storePath, sessionKey: "agent:main:main" }),
    ).toBeUndefined();
  });

  it("rejects JSON-only legacy ownership without creating a SQLite store", async () => {
    const { env } = createFixture("openclaw-main-key-json-only-");
    const cfg = {
      agents: { list: [{ id: "ops", default: true }] },
      session: { store: path.join(env.OPENCLAW_STATE_DIR!, "current", "{agentId}.json") },
    } satisfies OpenClawConfig;
    const legacyStorePath = resolveStorePath(undefined, { agentId: "main", env });
    const sqlitePath = resolveSqliteTargetFromSessionStorePath(legacyStorePath, {
      agentId: "main",
    }).path;
    fs.mkdirSync(path.dirname(legacyStorePath), { recursive: true });
    fs.writeFileSync(
      legacyStorePath,
      JSON.stringify({ "agent:main:main": { sessionId: "legacy-json", updatedAt: 10 } }),
    );

    const result = await migrateLegacyDefaultMainSessionKeys(cfg, env);

    expect(outcomeOfKind(result.outcomes, "legacy-json-present")).toMatchObject({
      resolved: false,
      sourceStorePath: legacyStorePath,
      legacyKeys: ["agent:main:main"],
    });
    expect(fs.existsSync(sqlitePath)).toBe(false);
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
