import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { migrateLegacyMainSessionKeys } from "./legacy-main-session-migration.js";
import { readExactSessionEntryRowForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type { SessionEntry } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type Fixture = {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
};

type LegacyMainSessionMigrationOutcomeKind = Awaited<
  ReturnType<typeof migrateLegacyMainSessionKeys>
>["outcomes"][number]["kind"];

function createFixture(cfg: OpenClawConfig = { agents: { entries: { ops: {} } } }): Fixture {
  const rawRoot = tempDirs.make("openclaw-legacy-main-session-");
  const root = fs.realpathSync.native(rawRoot);
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    cfg,
    env: { ...process.env, OPENCLAW_AGENT_DIR: undefined, OPENCLAW_STATE_DIR: stateDir },
    stateDir,
  };
}

function databasePath(stateDir: string, agentId: string): string {
  return path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
}

function seedClaim(params: {
  databaseAgentId: string;
  databasePath: string;
  entry?: SessionEntry;
  events?: unknown[];
  key: string;
}): SessionEntry {
  const entry = params.entry ?? {
    sessionId: `session-${params.key.replaceAll(":", "-")}`,
    updatedAt: 100,
  };
  runOpenClawAgentWriteTransaction(
    (database) => {
      writeSessionEntry(database, params.key, entry, {
        allowStoredAliases: true,
        previousEntry: null,
      });
      for (const event of params.events ?? [{ type: "message", id: "event-1", text: "hello" }]) {
        appendTranscriptEventInTransaction(
          database,
          {
            agentId: params.databaseAgentId,
            path: params.databasePath,
            sessionId: entry.sessionId,
            sessionKey: params.key,
          },
          event,
          { allowStoredAlias: true },
        );
      }
    },
    { agentId: params.databaseAgentId, path: params.databasePath },
  );
  return entry;
}

function readClaim(params: { databaseAgentId: string; databasePath: string; key: string }) {
  return runOpenClawAgentWriteTransaction(
    (database) => {
      const entry = readExactSessionEntryRowForCanonicalRepair(database, params.key)?.entry;
      return entry
        ? {
            entry,
            events: readTranscriptEventRows(database, entry.sessionId).map((row) => row.eventJson),
          }
        : undefined;
    },
    { agentId: params.databaseAgentId, path: params.databasePath },
  );
}

function outcomeKinds(result: Awaited<ReturnType<typeof migrateLegacyMainSessionKeys>>) {
  return result.outcomes.map((outcome) => outcome.kind);
}

function setLedgerStatus(env: NodeJS.ProcessEnv, status: string): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.prepare("UPDATE migration_sources SET status = ? WHERE source_key = ?").run(
        status,
        "legacy-main-session-keys",
      );
    },
    { env },
    { operationLabel: "test.legacy-main-session-ledger-status" },
  );
}

function readLedgerReport(env: NodeJS.ProcessEnv): unknown {
  return withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) => {
      const row = db
        .prepare("SELECT report_json FROM migration_sources WHERE source_key = ?")
        .get("legacy-main-session-keys") as { report_json?: unknown } | undefined;
      return typeof row?.report_json === "string" ? JSON.parse(row.report_json) : undefined;
    },
    { env },
  );
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("legacy main session migration", () => {
  const closedOutcomeCases = [
    {
      kind: "not-armed",
      run: async () => {
        const fixture = createFixture({ agents: { entries: { main: {}, ops: {} } } });
        const result = await migrateLegacyMainSessionKeys({
          cfg: fixture.cfg,
          env: fixture.env,
          mode: "detect",
        });
        expect(result.changes).toEqual([]);
        return result;
      },
    },
    {
      kind: "no-legacy-rows",
      run: async () => {
        const fixture = createFixture();
        const result = await migrateLegacyMainSessionKeys({
          cfg: fixture.cfg,
          env: fixture.env,
          mode: "detect",
        });
        expect(fs.existsSync(resolveOpenClawStateSqlitePath(fixture.env))).toBe(false);
        return result;
      },
    },
    {
      kind: "migrated-in-place",
      run: async () => {
        const fixture = createFixture({
          agents: { entries: { ops: {} } },
          session: { store: path.join(tempDirs.make("shared-store-"), "sessions.sqlite") },
        });
        seedClaim({
          databaseAgentId: "main",
          databasePath: fixture.cfg.session!.store!,
          key: "agent:main:chat",
        });
        const result = await migrateLegacyMainSessionKeys({
          cfg: fixture.cfg,
          env: fixture.env,
          mode: "detect",
        });
        expect(result.changes).toEqual([]);
        return result;
      },
    },
    {
      kind: "migrated-cross-store",
      run: async () => {
        const fixture = createFixture();
        seedClaim({
          databaseAgentId: "main",
          databasePath: databasePath(fixture.stateDir, "main"),
          events: [{ kind: "repeat" }, { kind: "repeat" }],
          key: "agent:main:chat",
        });
        const result = await migrateLegacyMainSessionKeys({
          cfg: fixture.cfg,
          env: fixture.env,
          mode: "automatic",
        });
        expect(
          readClaim({
            databaseAgentId: "ops",
            databasePath: databasePath(fixture.stateDir, "ops"),
            key: "agent:ops:chat",
          })?.events,
        ).toEqual(['{"kind":"repeat"}', '{"kind":"repeat"}']);
        return result;
      },
    },
    {
      kind: "canonical-exists-identical",
      run: async () => {
        const fixture = createFixture();
        const entry: SessionEntry = { sessionId: "same-session", updatedAt: 200 };
        seedClaim({
          databaseAgentId: "main",
          databasePath: databasePath(fixture.stateDir, "main"),
          entry,
          key: "agent:main:chat",
        });
        seedClaim({
          databaseAgentId: "ops",
          databasePath: databasePath(fixture.stateDir, "ops"),
          entry,
          key: "agent:ops:chat",
        });
        return await migrateLegacyMainSessionKeys({
          cfg: fixture.cfg,
          env: fixture.env,
          mode: "automatic",
        });
      },
    },
    {
      kind: "divergent-canonical",
      run: async () => {
        const fixture = createFixture();
        seedClaim({
          databaseAgentId: "main",
          databasePath: databasePath(fixture.stateDir, "main"),
          entry: { sessionId: "legacy", updatedAt: 100 },
          key: "agent:main:chat",
        });
        seedClaim({
          databaseAgentId: "ops",
          databasePath: databasePath(fixture.stateDir, "ops"),
          entry: { sessionId: "canonical", updatedAt: 100 },
          key: "agent:ops:chat",
        });
        return await migrateLegacyMainSessionKeys({
          cfg: fixture.cfg,
          env: fixture.env,
          mode: "automatic",
        });
      },
    },
    {
      kind: "divergent-aliases",
      run: async () => {
        const root = tempDirs.make("alias-stores-");
        const fixture = createFixture({
          agents: { entries: { ops: {} } },
          session: { store: path.join(root, "sessions.{agentId}.sqlite") },
        });
        seedClaim({
          databaseAgentId: "main",
          databasePath: path.join(root, "sessions.main.sqlite"),
          entry: { sessionId: "alias-one", updatedAt: 100 },
          key: "agent:main:chat",
        });
        seedClaim({
          databaseAgentId: "main",
          databasePath: path.join(root, "sessions.ops.sqlite"),
          entry: { sessionId: "alias-two", updatedAt: 200 },
          key: "agent:main:chat",
        });
        const result = await migrateLegacyMainSessionKeys({
          cfg: fixture.cfg,
          env: fixture.env,
          mode: "automatic",
        });
        expect(
          readClaim({
            databaseAgentId: "main",
            databasePath: path.join(root, "sessions.main.sqlite"),
            key: "agent:main:chat",
          }),
        ).toBeDefined();
        expect(
          readClaim({
            databaseAgentId: "main",
            databasePath: path.join(root, "sessions.ops.sqlite"),
            key: "agent:main:chat",
          }),
        ).toBeDefined();
        return result;
      },
    },
    {
      kind: "legacy-json-store",
      run: async () => {
        const fixture = createFixture();
        const jsonPath = path.join(fixture.stateDir, "agents", "main", "sessions", "sessions.json");
        fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
        fs.writeFileSync(jsonPath, "{}\n");
        return await migrateLegacyMainSessionKeys({
          cfg: fixture.cfg,
          env: fixture.env,
          mode: "detect",
        });
      },
    },
    {
      kind: "store-unreadable",
      run: async () => {
        const unreadablePath = path.join(tempDirs.make("unreadable-store-"), "sessions.sqlite");
        fs.symlinkSync(`${unreadablePath}.missing`, unreadablePath);
        const fixture = createFixture({
          agents: { entries: { ops: {} } },
          session: { store: unreadablePath },
        });
        return await migrateLegacyMainSessionKeys({
          cfg: fixture.cfg,
          env: fixture.env,
          mode: "detect",
        });
      },
    },
  ] satisfies Array<{
    kind: LegacyMainSessionMigrationOutcomeKind;
    run: () => Promise<Awaited<ReturnType<typeof migrateLegacyMainSessionKeys>>>;
  }>;

  it.each(closedOutcomeCases)("reports the $kind outcome", async ({ kind, run }) => {
    expect(outcomeKinds(await run())).toContain(kind);
  });

  it("keeps divergent canonical claims intact and detects mid-stream transcript divergence", async () => {
    const fixture = createFixture();
    const entry: SessionEntry = { sessionId: "shared-id", updatedAt: 100 };
    seedClaim({
      databaseAgentId: "main",
      databasePath: databasePath(fixture.stateDir, "main"),
      entry,
      events: [{ id: "one" }, { id: "legacy-two" }],
      key: "agent:main:chat",
    });
    seedClaim({
      databaseAgentId: "ops",
      databasePath: databasePath(fixture.stateDir, "ops"),
      entry,
      events: [{ id: "one" }, { id: "canonical-two" }],
      key: "agent:ops:chat",
    });

    const result = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "automatic",
    });

    expect(outcomeKinds(result)).toContain("divergent-canonical");
    expect(result.complete).toBe(false);
    expect(
      readClaim({
        databaseAgentId: "main",
        databasePath: databasePath(fixture.stateDir, "main"),
        key: "agent:main:chat",
      }),
    ).toBeDefined();
    expect(
      readClaim({
        databaseAgentId: "ops",
        databasePath: databasePath(fixture.stateDir, "ops"),
        key: "agent:ops:chat",
      }),
    ).toBeDefined();
  });

  it("migrates an in-place alias atomically to the owner key", async () => {
    const storePath = path.join(tempDirs.make("in-place-migration-"), "sessions.sqlite");
    const fixture = createFixture({
      agents: { entries: { ops: {} } },
      session: { store: storePath },
    });
    seedClaim({ databaseAgentId: "main", databasePath: storePath, key: "agent:main:chat" });

    const result = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "automatic",
    });

    expect(outcomeKinds(result)).toContain("migrated-in-place");
    expect(
      readClaim({ databaseAgentId: "main", databasePath: storePath, key: "agent:main:chat" }),
    ).toBeUndefined();
    expect(
      readClaim({ databaseAgentId: "main", databasePath: storePath, key: "agent:ops:chat" }),
    ).toBeDefined();
  });

  it.each([
    { copiedBeforeCrash: true, label: "copy committed before source cleanup" },
    { copiedBeforeCrash: false, label: "source cleanup committed before ledger" },
  ])("converges when $label", async ({ copiedBeforeCrash }) => {
    const fixture = createFixture();
    const entry: SessionEntry = { sessionId: "crash-window", updatedAt: 100 };
    if (copiedBeforeCrash) {
      seedClaim({
        databaseAgentId: "main",
        databasePath: databasePath(fixture.stateDir, "main"),
        entry,
        key: "agent:main:chat",
      });
    }
    seedClaim({
      databaseAgentId: "ops",
      databasePath: databasePath(fixture.stateDir, "ops"),
      entry,
      key: "agent:ops:chat",
    });

    const converged = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "automatic",
    });
    const ledgerRerun = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "automatic",
    });

    expect(converged.complete).toBe(true);
    expect(
      readClaim({
        databaseAgentId: "main",
        databasePath: databasePath(fixture.stateDir, "main"),
        key: "agent:main:chat",
      }),
    ).toBeUndefined();
    expect(
      readClaim({
        databaseAgentId: "ops",
        databasePath: databasePath(fixture.stateDir, "ops"),
        key: "agent:ops:chat",
      }),
    ).toBeDefined();
    expect(ledgerRerun.outcomes).toEqual([
      { kind: "no-legacy-rows", detail: "matching completed ledger" },
    ]);
  });

  it("quarantines losing claims without overwriting existing quarantine keys", async () => {
    const fixture = createFixture();
    const mainPath = databasePath(fixture.stateDir, "main");
    seedClaim({
      databaseAgentId: "main",
      databasePath: mainPath,
      entry: { sessionId: "legacy", updatedAt: 100 },
      key: "agent:main:chat",
    });
    seedClaim({
      databaseAgentId: "main",
      databasePath: mainPath,
      entry: { sessionId: "occupied", updatedAt: 50 },
      key: "agent:ops:legacy-main-conflict-1",
    });
    seedClaim({
      databaseAgentId: "ops",
      databasePath: databasePath(fixture.stateDir, "ops"),
      entry: { sessionId: "canonical", updatedAt: 200 },
      key: "agent:ops:chat",
    });

    const result = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "doctor-fix",
    });

    const outcome = result.outcomes.find((entry) => entry.kind === "divergent-canonical");
    expect(outcome?.quarantinedKeys).toEqual(["agent:ops:legacy-main-conflict-2"]);
    expect(
      readClaim({ databaseAgentId: "main", databasePath: mainPath, key: "agent:main:chat" }),
    ).toBeUndefined();
    expect(
      readClaim({
        databaseAgentId: "main",
        databasePath: mainPath,
        key: "agent:ops:legacy-main-conflict-2",
      })?.events,
    ).toEqual(['{"type":"message","id":"event-1","text":"hello"}']);
  });

  it("uses a completed ledger once and rearms when its identity changes", async () => {
    const fixture = createFixture();
    const first = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "automatic",
      now: () => 100,
    });
    const second = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "automatic",
      now: () => 200,
    });
    expect(readLedgerReport(fixture.env)).toMatchObject({
      mainKey: "main",
      outcomes: [{ kind: "no-legacy-rows" }],
      ownerAgentId: "ops",
    });
    setLedgerStatus(fixture.env, "failed");
    const nonComplete = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "detect",
    });
    const changedMainKey: OpenClawConfig = {
      ...fixture.cfg,
      session: { ...fixture.cfg.session, mainKey: "primary" },
    };
    const rearmed = await migrateLegacyMainSessionKeys({
      cfg: changedMainKey,
      env: fixture.env,
      mode: "detect",
    });
    const reowned = await migrateLegacyMainSessionKeys({
      cfg: { agents: { entries: { research: {} } } },
      env: fixture.env,
      mode: "detect",
    });

    expect(first.complete).toBe(true);
    expect(second.outcomes).toEqual([
      { kind: "no-legacy-rows", detail: "matching completed ledger" },
    ]);
    expect(nonComplete.outcomes).toEqual([{ kind: "no-legacy-rows" }]);
    expect(rearmed.mainKey).toBe("primary");
    expect(rearmed.outcomes).toEqual([{ kind: "no-legacy-rows" }]);
    expect(reowned).toMatchObject({
      ownerAgentId: "research",
      outcomes: [{ kind: "no-legacy-rows" }],
    });
  });

  it("uses an explicit migration owner when the multi-agent roster is unambiguous", async () => {
    const resolved = createFixture({
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
      session: { store: path.join(tempDirs.make("fixed-store-owner-"), "sessions.sqlite") },
    });
    const unresolved = createFixture({
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    });
    seedClaim({
      databaseAgentId: "main",
      databasePath: databasePath(unresolved.stateDir, "main"),
      key: "agent:main:chat",
    });
    const perAgentPinned = createFixture({
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    });

    const armed = await migrateLegacyMainSessionKeys({
      cfg: resolved.cfg,
      env: resolved.env,
      mode: "detect",
    });
    const notArmed = await migrateLegacyMainSessionKeys({
      cfg: unresolved.cfg,
      env: unresolved.env,
      mode: "detect",
    });
    const perAgentArmed = await migrateLegacyMainSessionKeys({
      cfg: perAgentPinned.cfg,
      env: perAgentPinned.env,
      mode: "detect",
    });

    expect(armed).toMatchObject({ armed: true, ownerAgentId: "ops" });
    expect(notArmed).toMatchObject({
      armed: false,
      outcomes: [{ kind: "not-armed", detail: "owner-unresolved" }],
    });
    expect(perAgentArmed).toMatchObject({ armed: true, ownerAgentId: "ops" });
    expect(notArmed.warnings[0]).toContain("agents.defaults.sessionStore.agentId");
  });

  it("proves an unresolved-owner store clean when it has no legacy rows", async () => {
    const fixture = createFixture({
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    });

    const result = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "detect",
    });

    expect(result).toMatchObject({
      armed: false,
      complete: true,
      ledgerComplete: false,
      outcomes: [{ kind: "no-legacy-rows", detail: "no configured owner" }],
      warnings: [],
    });
  });

  it("keeps unresolved ownership advisory when a candidate store is unreadable", async () => {
    const unreadablePath = path.join(tempDirs.make("unresolved-unreadable-"), "sessions.sqlite");
    fs.symlinkSync(`${unreadablePath}.missing`, unreadablePath);
    const fixture = createFixture({
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      session: { store: unreadablePath },
    });

    const result = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "automatic",
    });

    expect(result).toMatchObject({
      armed: false,
      complete: false,
      ledgerComplete: false,
      outcomes: [{ kind: "not-armed", detail: "owner-unresolved" }],
    });
    expect(result.warnings[0]).toContain("agents.defaults.sessionStore.agentId");
  });

  it("uses an explicit migration owner for retired main rows in per-agent stores", async () => {
    const fixture = createFixture({
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    });
    const mainPath = databasePath(fixture.stateDir, "main");
    seedClaim({ databaseAgentId: "main", databasePath: mainPath, key: "agent:main:chat" });

    const result = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "automatic",
    });

    expect(result).toMatchObject({ armed: true, complete: true, ownerAgentId: "ops" });
    expect(
      readClaim({ databaseAgentId: "main", databasePath: mainPath, key: "agent:main:chat" }),
    ).toBeUndefined();
    expect(
      readClaim({
        databaseAgentId: "ops",
        databasePath: databasePath(fixture.stateDir, "ops"),
        key: "agent:ops:chat",
      }),
    ).toBeDefined();
  });

  it("keeps automatic detection non-throwing for unreadable stores and treats ENOENT as absence", async () => {
    const absent = createFixture();
    const unreadablePath = path.join(tempDirs.make("automatic-unreadable-"), "sessions.sqlite");
    fs.symlinkSync(`${unreadablePath}.missing`, unreadablePath);
    const unreadable = createFixture({
      agents: { entries: { ops: {} } },
      session: { store: unreadablePath },
    });

    const absentResult = await migrateLegacyMainSessionKeys({
      cfg: absent.cfg,
      env: absent.env,
      mode: "automatic",
    });
    const unreadableResult = await migrateLegacyMainSessionKeys({
      cfg: unreadable.cfg,
      env: unreadable.env,
      mode: "automatic",
    });

    expect(absentResult).toMatchObject({ complete: true, outcomes: [{ kind: "no-legacy-rows" }] });
    expect(outcomeKinds(unreadableResult)).toContain("store-unreadable");
    expect(unreadableResult.warnings.join("\n")).toContain(unreadablePath);
    await expect(
      migrateLegacyMainSessionKeys({
        cfg: unreadable.cfg,
        env: unreadable.env,
        mode: "doctor-fix",
      }),
    ).rejects.toThrow(`cannot read legacy session store ${unreadablePath}`);
  });

  it("keeps automatic mode report-only while a legacy JSON candidate blocks inspection", async () => {
    const fixture = createFixture();
    const mainPath = databasePath(fixture.stateDir, "main");
    seedClaim({ databaseAgentId: "main", databasePath: mainPath, key: "agent:main:chat" });
    const jsonPath = path.join(fixture.stateDir, "agents", "main", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, "{}\n");

    const result = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "automatic",
    });

    expect(outcomeKinds(result)).toContain("legacy-json-store");
    expect(result.changes).toEqual([]);
    expect(
      readClaim({ databaseAgentId: "main", databasePath: mainPath, key: "agent:main:chat" }),
    ).toBeDefined();
    expect(
      readClaim({
        databaseAgentId: "ops",
        databasePath: databasePath(fixture.stateDir, "ops"),
        key: "agent:ops:chat",
      }),
    ).toBeUndefined();
  });

  it("dedupes symlinked state roots by physical database identity", async () => {
    const fixture = createFixture();
    fixture.cfg = {
      agents: { entries: { ops: {} } },
      session: {
        store: path.join(fixture.stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
      },
    };
    const stateAlias = path.join(path.dirname(fixture.stateDir), "state-alias");
    fs.symlinkSync(fixture.stateDir, stateAlias, "dir");
    seedClaim({
      databaseAgentId: "main",
      databasePath: databasePath(fixture.stateDir, "main"),
      key: "agent:main:chat",
    });
    const env = { ...fixture.env, OPENCLAW_STATE_DIR: stateAlias };

    const result = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env,
      mode: "automatic",
    });

    expect(
      result.outcomes.filter((outcome) => outcome.canonicalKey === "agent:ops:chat"),
    ).toHaveLength(1);
    expect(outcomeKinds(result)).toContain("migrated-cross-store");
  });
});
