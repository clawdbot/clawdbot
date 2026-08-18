import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { isSecretValueRegisteredForRedaction } from "../../logging/secret-redaction-registry.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "../../state/openclaw-state-db.js";
import {
  consumeGitHubSetupHandoff,
  deleteSecretStoreEntry,
  listSecretStoreEntries,
  purgeExpiredSecretStoreEntries,
  readSecretStoreExecEnvironment,
  readSecretStoreValue,
  SECRET_STORE_VALUE_MAX_BYTES,
  writeSecretStoreEntry,
} from "./secret-store.js";

const roots: string[] = [];
const team = { kind: "team" } as const;

function createDatabaseOptions() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-secret-store-")));
  roots.push(root);
  return { path: path.join(root, "state.sqlite") };
}

function countStoredRows(database: ReturnType<typeof createDatabaseOptions>, name: string): number {
  const row = openOpenClawStateDatabase(database)
    .db.prepare("SELECT COUNT(*) AS count FROM secret_store_entries WHERE name = ?")
    .get(name) as { count: number };
  return row.count;
}

afterEach(() => {
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("secret store", () => {
  it("consumes only a fresh, unbound GitHub setup handoff", () => {
    const database = createDatabaseOptions();
    const name = "github-setup-11111111111111111111111111111111";
    writeSecretStoreEntry({
      scope: team,
      name,
      value: "temporary-value",
      kind: "secret",
      allowedHosts: [],
      updatedBy: "test",
      database,
    });
    writeSecretStoreEntry({
      scope: team,
      name: "DEPLOY_TOKEN",
      value: "unrelated-value",
      kind: "secret",
      updatedBy: "test",
      database,
    });

    expect(consumeGitHubSetupHandoff({ name, database })).toBe("temporary-value");
    expect(countStoredRows(database, name)).toBe(0);
    expect(consumeGitHubSetupHandoff({ name, database })).toBeUndefined();
    expect(consumeGitHubSetupHandoff({ name: "DEPLOY_TOKEN", database })).toBeUndefined();
    expect(readSecretStoreValue({ scope: team, name: "DEPLOY_TOKEN", database })).toEqual({
      ok: true,
      value: "unrelated-value",
    });
  });

  it("round-trips env and secret entries without disclosing secret list values", () => {
    const database = createDatabaseOptions();
    writeSecretStoreEntry({
      scope: team,
      name: "SERVICE_URL",
      value: "https://service.test",
      kind: "env",
      updatedBy: "test",
      database,
    });
    writeSecretStoreEntry({
      scope: team,
      name: "SERVICE_API_KEY",
      value: "stored-super-secret",
      kind: "secret",
      allowedHosts: ["API.EXAMPLE.COM", "bücher.example"],
      updatedBy: "test",
      database,
    });

    expect(listSecretStoreEntries({ scope: team, database })).toEqual([
      expect.objectContaining({
        name: "SERVICE_API_KEY",
        kind: "secret",
        allowedHosts: ["api.example.com", "xn--bcher-kva.example"],
      }),
      expect.objectContaining({
        name: "SERVICE_URL",
        kind: "env",
        valuePreview: "https://service.test",
      }),
    ]);
    expect(listSecretStoreEntries({ scope: team, database })[0]).not.toHaveProperty("valuePreview");
    expect(readSecretStoreValue({ scope: team, name: "SERVICE_API_KEY", database })).toEqual({
      ok: true,
      value: "stored-super-secret",
    });
    expect(isSecretValueRegisteredForRedaction("stored-super-secret")).toBe(true);
    expect(
      readSecretStoreExecEnvironment({ includeSecretSentinels: true, database })
        .secretEgressBindings,
    ).toEqual([
      expect.objectContaining({
        name: "SERVICE_API_KEY",
        allowedHosts: ["api.example.com", "xn--bcher-kva.example"],
      }),
    ]);
    expect(
      readSecretStoreExecEnvironment({
        includeSecretSentinels: true,
        excludeNames: ["SERVICE_API_KEY"],
        database,
      }),
    ).not.toHaveProperty("secretSentinels");
  });

  it("soft-deletes idempotently and purges after the 30-day retention", () => {
    const database = createDatabaseOptions();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    writeSecretStoreEntry({
      scope: team,
      name: "DELETE_TOKEN",
      value: "delete-me",
      kind: "secret",
      updatedBy: null,
      database,
    });
    deleteSecretStoreEntry({ scope: team, name: "DELETE_TOKEN", database });
    deleteSecretStoreEntry({ scope: team, name: "DELETE_TOKEN", database });
    expect(listSecretStoreEntries({ scope: team, database })).toEqual([]);
    expect(listSecretStoreEntries({ scope: team, includeDeleted: true, database })).toHaveLength(1);
    expect(purgeExpiredSecretStoreEntries({ database })).toBe(0);

    vi.setSystemTime(new Date("2026-02-01T00:00:00.001Z"));
    expect(purgeExpiredSecretStoreEntries({ database })).toBe(1);
    expect(listSecretStoreEntries({ scope: team, includeDeleted: true, database })).toEqual([]);
  });

  it.each([
    { kind: "env" as const, allowedHosts: undefined, ageMs: 0 },
    { kind: "secret" as const, allowedHosts: ["github.com"], ageMs: 0 },
    { kind: "secret" as const, allowedHosts: undefined, ageMs: 10 * 60_000 + 1 },
  ])("rejects a non-handoff store entry %#", ({ kind, allowedHosts, ageMs }) => {
    const database = createDatabaseOptions();
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now - ageMs);
    writeSecretStoreEntry({
      scope: team,
      name: "github-setup-22222222222222222222222222222222",
      value: "temporary-value",
      kind,
      ...(allowedHosts ? { allowedHosts } : {}),
      updatedBy: "test",
      database,
    });
    expect(
      consumeGitHubSetupHandoff({
        name: "github-setup-22222222222222222222222222222222",
        nowMs: now,
        database,
      }),
    ).toBeUndefined();
  });

  it("keeps setup handoffs out of listings and exec and hard-deletes abandoned generations", () => {
    const database = createDatabaseOptions();
    const name = "github-setup-33333333333333333333333333333333";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    writeSecretStoreEntry({
      scope: team,
      name,
      value: "abandoned-value",
      kind: "secret",
      allowedHosts: [],
      updatedBy: "test",
      database,
    });
    writeSecretStoreEntry({
      scope: team,
      name: "UNRELATED_SECRET",
      value: "keep-value",
      kind: "secret",
      updatedBy: "test",
      database,
    });

    expect(listSecretStoreEntries({ scope: team, database }).map((entry) => entry.name)).toEqual([
      "UNRELATED_SECRET",
    ]);
    expect(
      listSecretStoreEntries({ scope: team, includeDeleted: true, database }).map(
        (entry) => entry.name,
      ),
    ).toEqual(["UNRELATED_SECRET"]);
    expect(
      readSecretStoreExecEnvironment({ includeSecretSentinels: true, database }).secretSentinels,
    ).not.toHaveProperty(name);
    vi.setSystemTime(new Date("2026-01-01T00:10:00.001Z"));
    expect(listSecretStoreEntries({ scope: team, database }).map((entry) => entry.name)).toEqual([
      "UNRELATED_SECRET",
    ]);
    expect(purgeExpiredSecretStoreEntries({ database })).toBe(1);
    expect(countStoredRows(database, name)).toBe(0);
    expect(readSecretStoreValue({ scope: team, name: "UNRELATED_SECRET", database })).toEqual({
      ok: true,
      value: "keep-value",
    });
  });

  it("hard-deletes reserved setup names while ordinary secrets remain soft-deleted", () => {
    const database = createDatabaseOptions();
    const name = "github-setup-44444444444444444444444444444444";
    writeSecretStoreEntry({
      scope: team,
      name,
      value: "temporary-value",
      kind: "secret",
      updatedBy: "test",
      database,
    });
    deleteSecretStoreEntry({ scope: team, name, database });
    expect(countStoredRows(database, name)).toBe(0);
  });

  it("makes duplicate team rows impossible at the schema boundary", () => {
    const database = createDatabaseOptions();
    writeSecretStoreEntry({
      scope: team,
      name: "UNIQUE_TOKEN",
      value: "first-value",
      kind: "secret",
      updatedBy: null,
      database,
    });
    const state = openOpenClawStateDatabase(database);
    expect(() =>
      state.db
        .prepare(
          "INSERT INTO secret_store_entries (scope_kind, scope_id, name, value, kind, created_at_ms, updated_at_ms) VALUES ('team', '', 'UNIQUE_TOKEN', 'duplicate', 'secret', 1, 1)",
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/u);
  });

  it("rejects invalid names and values over the UTF-8 byte cap", () => {
    const database = createDatabaseOptions();
    expect(() =>
      writeSecretStoreEntry({
        scope: team,
        name: "lowercase",
        value: "value",
        kind: "env",
        updatedBy: null,
        database,
      }),
    ).toThrow(expect.objectContaining({ code: "SECRET_STORE_INVALID_NAME" }));
    expect(() =>
      writeSecretStoreEntry({
        scope: team,
        name: "github-setup-token",
        value: "value",
        kind: "secret",
        updatedBy: null,
        database,
      }),
    ).toThrow(expect.objectContaining({ code: "SECRET_STORE_INVALID_NAME" }));
    expect(() =>
      writeSecretStoreEntry({
        scope: team,
        name: "LARGE_SECRET",
        value: "é".repeat(SECRET_STORE_VALUE_MAX_BYTES / 2 + 1),
        kind: "secret",
        updatedBy: null,
        database,
      }),
    ).toThrow(expect.objectContaining({ code: "SECRET_STORE_VALUE_TOO_LARGE" }));
  });

  it.each(["*.example.com", "https://api.example.com", "api.example.com:443", "bad host"])(
    "rejects invalid allowed host %s at write time",
    (allowedHost) => {
      expect(() =>
        writeSecretStoreEntry({
          scope: team,
          name: "HOST_BOUND_SECRET",
          value: "value",
          kind: "secret",
          allowedHosts: [allowedHost],
          updatedBy: null,
          database: createDatabaseOptions(),
        }),
      ).toThrow(expect.objectContaining({ code: "SECRET_STORE_INVALID_ALLOWED_HOST" }));
    },
  );

  it("rejects an empty secret value but keeps empty env values legal", () => {
    const database = createDatabaseOptions();
    // A silently-empty secret (a failed `op read |` pipe) is undiagnosable later:
    // get refuses secret kinds and listings mask them, so reject it at the writer.
    expect(() =>
      writeSecretStoreEntry({
        scope: team,
        name: "EMPTY_SECRET",
        value: "",
        kind: "secret",
        updatedBy: null,
        database,
      }),
    ).toThrow(expect.objectContaining({ code: "SECRET_STORE_VALUE_EMPTY" }));

    writeSecretStoreEntry({
      scope: team,
      name: "EMPTY_ENV",
      value: "",
      kind: "env",
      updatedBy: null,
      database,
    });
    const stored = readSecretStoreValue({ scope: team, name: "EMPTY_ENV", database });
    expect(stored.ok && stored.value).toBe("");
  });

  it("treats a missing lazy table as empty and preserves the current schema version", () => {
    const database = createDatabaseOptions();
    openOpenClawStateDatabase(database);
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const before = new DatabaseSync(database.path);
    expect(before.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    before.exec("DROP TABLE secret_store_entries;");
    before.close();

    expect(listSecretStoreEntries({ scope: team, database })).toEqual([]);
    expect(readSecretStoreValue({ scope: team, name: "MISSING_SECRET", database })).toMatchObject({
      ok: false,
      error: { code: "SECRET_STORE_NOT_FOUND" },
    });
    const stillMissing = new DatabaseSync(database.path, { readOnly: true });
    expect(
      stillMissing
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("secret_store_entries"),
    ).toBeUndefined();
    stillMissing.close();

    writeSecretStoreEntry({
      scope: team,
      name: "CREATED_SECRET",
      value: "created-after-lazy-ensure",
      kind: "secret",
      updatedBy: null,
      database,
    });
    closeOpenClawStateDatabaseForTest();
    const after = new DatabaseSync(database.path, { readOnly: true });
    expect(after.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(
      after
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = ?")
        .get("secret_store_entries_live_idx"),
    ).toEqual({ name: "secret_store_entries_live_idx" });
    after.close();
  });
});
