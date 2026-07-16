// Doctor TUI last-session migration tests cover strict import and source cleanup.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { readTuiLastSessionKey } from "../tui/tui-last-session.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  detectLegacyTuiLastSessions,
  migrateLegacyTuiLastSessions,
} from "./state-migrations.tui-last-session.js";

type TuiLastSessionTestDatabase = Pick<OpenClawStateKyselyDatabase, "tui_last_sessions">;

const tempDirs: string[] = [];

function makeStateDir(): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tui-migration-"));
  tempDirs.push(stateDir);
  return stateDir;
}

function legacyTuiLastSessionPath(stateDir: string): string {
  return path.join(stateDir, "tui", "last-session.json");
}

function writeLegacyStore(stateDir: string, value: unknown): string {
  const sourcePath = legacyTuiLastSessionPath(stateDir);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return sourcePath;
}

function migrate(
  stateDir: string,
  overrides?: {
    beforeClaim?: () => void;
    beforeVerify?: () => void;
    removeSource?: () => void;
  },
) {
  const sourcePath = legacyTuiLastSessionPath(stateDir);
  return migrateLegacyTuiLastSessions({
    detected: { sourcePath, hasLegacy: true },
    stateDir,
    ...(overrides?.beforeClaim ? { beforeClaim: overrides.beforeClaim } : {}),
    ...(overrides?.beforeVerify ? { beforeVerify: overrides.beforeVerify } : {}),
    ...(overrides?.removeSource ? { removeSource: () => overrides.removeSource?.() } : {}),
  });
}

function seedPointer(params: {
  stateDir: string;
  scopeKey: string;
  sessionKey: string;
  updatedAt: number;
}): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<TuiLastSessionTestDatabase>(db).insertInto("tui_last_sessions").values({
          scope_key: params.scopeKey,
          session_key: params.sessionKey,
          updated_at: params.updatedAt,
        }),
      );
    },
    { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } },
  );
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("legacy TUI last-session migration", () => {
  it("runs only through explicit doctor detection and discards heartbeat pointers", async () => {
    const stateDir = makeStateDir();
    const sourcePath = writeLegacyStore(stateDir, {
      terminal: { sessionKey: "agent:main:tui-123", updatedAt: 100 },
      heartbeat: { sessionKey: "agent:main:telegram:direct:123:heartbeat", updatedAt: 200 },
    });
    const runtimeDetection = detectLegacyTuiLastSessions({ stateDir });
    expect(runtimeDetection.hasLegacy).toBe(false);
    await expect(readTuiLastSessionKey({ scopeKey: "terminal", stateDir })).resolves.toBeNull();
    expect(fs.existsSync(sourcePath)).toBe(true);

    const doctorDetection = detectLegacyTuiLastSessions({
      stateDir,
      doctorOnlyStateMigrations: true,
    });
    expect(doctorDetection.hasLegacy).toBe(true);
    const result = migrateLegacyTuiLastSessions({
      detected: doctorDetection,
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(
      "Migrated 1 TUI last-session pointer(s) → shared SQLite state",
    );
    expect(result.changes).toContain("Discarded 1 legacy heartbeat TUI restore pointer(s)");
    expect(fs.existsSync(sourcePath)).toBe(false);
    await expect(readTuiLastSessionKey({ scopeKey: "terminal", stateDir })).resolves.toBe(
      "agent:main:tui-123",
    );
    await expect(readTuiLastSessionKey({ scopeKey: "heartbeat", stateDir })).resolves.toBeNull();
    expect(fs.readdirSync(path.dirname(sourcePath))).not.toContain("last-session.json.migrated");
  });

  it.each([
    ["non-object top level", []],
    ["non-object record", { terminal: "agent:main:tui-123" }],
    ["missing timestamp", { terminal: { sessionKey: "agent:main:tui-123" } }],
    [
      "unknown field",
      { terminal: { sessionKey: "agent:main:tui-123", updatedAt: 100, extra: true } },
    ],
  ])("retains malformed source: %s", async (_label, value) => {
    const stateDir = makeStateDir();
    const sourcePath = writeLegacyStore(stateDir, value);

    const result = migrate(stateDir);

    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("Failed reading legacy TUI last-session state");
    expect(fs.existsSync(sourcePath)).toBe(true);
    await expect(readTuiLastSessionKey({ scopeKey: "terminal", stateDir })).resolves.toBeNull();
  });

  it("keeps a newer SQLite pointer and removes its superseded source", async () => {
    const stateDir = makeStateDir();
    const sourcePath = writeLegacyStore(stateDir, {
      terminal: { sessionKey: "agent:main:legacy", updatedAt: 100 },
    });
    seedPointer({
      stateDir,
      scopeKey: "terminal",
      sessionKey: "agent:main:current",
      updatedAt: 200,
    });

    const result = migrate(stateDir);

    expect(result.warnings).toEqual([]);
    expect(result.notices).toEqual([
      "Kept 1 newer shared SQLite TUI last-session pointer(s) over legacy JSON",
    ]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    await expect(readTuiLastSessionKey({ scopeKey: "terminal", stateDir })).resolves.toBe(
      "agent:main:current",
    );
  });

  it("fails closed on equal-timestamp divergence", async () => {
    const stateDir = makeStateDir();
    const sourcePath = writeLegacyStore(stateDir, {
      terminal: { sessionKey: "agent:main:legacy", updatedAt: 100 },
    });
    seedPointer({
      stateDir,
      scopeKey: "terminal",
      sessionKey: "agent:main:current",
      updatedAt: 100,
    });

    const result = migrate(stateDir);

    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain(
      "divergent JSON and SQLite pointers at the same timestamp",
    );
    expect(fs.existsSync(sourcePath)).toBe(true);
    await expect(readTuiLastSessionKey({ scopeKey: "terminal", stateDir })).resolves.toBe(
      "agent:main:current",
    );
  });

  it("retains a source that changes before verification", async () => {
    const stateDir = makeStateDir();
    const sourcePath = writeLegacyStore(stateDir, {
      terminal: { sessionKey: "agent:main:first", updatedAt: 100 },
    });

    const result = migrate(stateDir, {
      beforeVerify: () => {
        fs.writeFileSync(
          sourcePath,
          `${JSON.stringify({ terminal: { sessionKey: "agent:main:second", updatedAt: 200 } })}\n`,
        );
      },
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("source changed after doctor loaded it");
    expect(fs.existsSync(sourcePath)).toBe(true);
    await expect(readTuiLastSessionKey({ scopeKey: "terminal", stateDir })).resolves.toBe(
      "agent:main:first",
    );
  });

  it("does not delete a replacement written after verification", async () => {
    const stateDir = makeStateDir();
    const sourcePath = writeLegacyStore(stateDir, {
      terminal: { sessionKey: "agent:main:first", updatedAt: 100 },
    });
    const replacement = `${sourcePath}.replacement`;

    const first = migrate(stateDir, {
      beforeClaim: () => {
        fs.writeFileSync(
          replacement,
          `${JSON.stringify({ terminal: { sessionKey: "agent:main:second", updatedAt: 200 } })}\n`,
        );
        fs.renameSync(replacement, sourcePath);
      },
    });

    expect(first.changes).toEqual([]);
    expect(first.warnings.join("\n")).toContain("source changed before doctor could claim it");
    expect(fs.existsSync(sourcePath)).toBe(true);
    await expect(readTuiLastSessionKey({ scopeKey: "terminal", stateDir })).resolves.toBe(
      "agent:main:first",
    );

    const retry = migrate(stateDir);
    expect(retry.warnings).toEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    await expect(readTuiLastSessionKey({ scopeKey: "terminal", stateDir })).resolves.toBe(
      "agent:main:second",
    );
  });

  it("retries source cleanup without overwriting the verified row", async () => {
    const stateDir = makeStateDir();
    const sourcePath = writeLegacyStore(stateDir, {
      terminal: { sessionKey: "agent:main:tui-123", updatedAt: 100 },
    });

    const first = migrate(stateDir, {
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    expect(first.warnings.join("\n")).toContain("simulated unlink failure");
    expect(fs.existsSync(sourcePath)).toBe(true);

    const retry = migrate(stateDir);
    expect(retry.warnings).toEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    await expect(readTuiLastSessionKey({ scopeKey: "terminal", stateDir })).resolves.toBe(
      "agent:main:tui-123",
    );
  });
});
