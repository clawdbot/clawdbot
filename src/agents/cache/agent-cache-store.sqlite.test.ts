import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  listOpenClawRegisteredAgentDatabases,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  clearExpiredSqliteAgentCacheEntries,
  clearSqliteAgentCacheEntries,
  createSqliteAgentCacheStore,
  deleteSqliteAgentCacheEntry,
  listSqliteAgentCacheEntries,
  readSqliteAgentCacheEntry,
  writeSqliteAgentCacheEntry,
} from "./agent-cache-store.sqlite.js";

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-cache-"));
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("SQLite agent cache store", () => {
  it("stores scoped JSON values and blobs in the agent database", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };

    expect(
      writeSqliteAgentCacheEntry({
        env,
        agentId: "Main",
        scope: "run:one",
        key: "payload",
        value: { status: "ok" },
        blob: "bytes",
        now: () => 1000,
      }),
    ).toEqual({
      agentId: "main",
      scope: "run:one",
      key: "payload",
      value: { status: "ok" },
      blob: Buffer.from("bytes"),
      expiresAt: null,
      updatedAt: 1000,
    });
    writeSqliteAgentCacheEntry({
      env,
      agentId: "main",
      scope: "run:two",
      key: "payload",
      value: { status: "other" },
    });

    expect(
      readSqliteAgentCacheEntry({
        env,
        agentId: "main",
        scope: "run:one",
        key: "payload",
      }),
    ).toEqual({
      agentId: "main",
      scope: "run:one",
      key: "payload",
      value: { status: "ok" },
      blob: Buffer.from("bytes"),
      expiresAt: null,
      updatedAt: 1000,
    });
    expect(listSqliteAgentCacheEntries({ env, agentId: "main", scope: "run:one" })).toEqual([
      expect.objectContaining({
        key: "payload",
        value: { status: "ok" },
      }),
    ]);
  });

  it("hides expired entries and clears expired rows", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };

    writeSqliteAgentCacheEntry({
      env,
      agentId: "main",
      scope: "runtime",
      key: "old",
      value: "stale",
      expiresAt: 1000,
      now: () => 900,
    });
    writeSqliteAgentCacheEntry({
      env,
      agentId: "main",
      scope: "runtime",
      key: "fresh",
      value: "ok",
      ttlMs: 10_000,
      now: () => 2000,
    });
    writeSqliteAgentCacheEntry({
      env,
      agentId: "main",
      scope: "other",
      key: "old",
      value: "kept",
      expiresAt: 1000,
    });

    expect(
      readSqliteAgentCacheEntry({
        env,
        agentId: "main",
        scope: "runtime",
        key: "old",
        now: () => 2000,
      }),
    ).toBeNull();
    expect(
      listSqliteAgentCacheEntries({ env, agentId: "main", scope: "runtime", now: () => 2000 }),
    ).toEqual([
      expect.objectContaining({
        key: "fresh",
        value: "ok",
        expiresAt: 12_000,
      }),
    ]);
    expect(
      clearExpiredSqliteAgentCacheEntries({
        env,
        agentId: "main",
        scope: "runtime",
        currentTime: 2000,
      }),
    ).toBe(1);
    expect(
      clearExpiredSqliteAgentCacheEntries({
        env,
        agentId: "main",
        scope: "other",
        currentTime: 2000,
      }),
    ).toBe(1);
  });

  it("rejects cache expiries outside the valid Date range", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };

    expect(() =>
      writeSqliteAgentCacheEntry({
        env,
        agentId: "main",
        scope: "runtime",
        key: "explicit-overflow",
        value: "bad",
        expiresAt: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow("SQLite agent cache expiresAt must be a valid Date timestamp.");
    expect(() =>
      writeSqliteAgentCacheEntry({
        env,
        agentId: "main",
        scope: "runtime",
        key: "ttl-overflow",
        value: "bad",
        ttlMs: 1000,
        now: () => MAX_DATE_TIMESTAMP_MS,
      }),
    ).toThrow("SQLite agent cache ttlMs must resolve to a valid Date timestamp.");
  });

  it("preserves explicit null cache expiry as non-expiring", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };

    expect(
      writeSqliteAgentCacheEntry({
        env,
        agentId: "main",
        scope: "runtime",
        key: "no-expiry",
        value: "ok",
        expiresAt: null,
        now: () => 1000,
      }),
    ).toEqual(
      expect.objectContaining({
        key: "no-expiry",
        value: "ok",
        expiresAt: null,
        updatedAt: 1000,
      }),
    );
    expect(
      readSqliteAgentCacheEntry({
        env,
        agentId: "main",
        scope: "runtime",
        key: "no-expiry",
        now: () => MAX_DATE_TIMESTAMP_MS,
      }),
    ).toEqual(expect.objectContaining({ key: "no-expiry", expiresAt: null }));
  });

  it("hides invalid persisted expiries and ignores invalid clear clocks", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };

    writeSqliteAgentCacheEntry({
      env,
      agentId: "main",
      scope: "runtime",
      key: "valid",
      value: "ok",
      ttlMs: 1000,
      now: () => 1000,
    });
    writeSqliteAgentCacheEntry({
      env,
      agentId: "main",
      scope: "runtime",
      key: "invalid",
      value: "bad",
      now: () => 1000,
    });
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    database.db
      .prepare("update cache_entries set expires_at = ? where scope = ? and key = ?")
      .run(Number.MAX_SAFE_INTEGER, "runtime", "invalid");

    expect(
      readSqliteAgentCacheEntry({
        env,
        agentId: "main",
        scope: "runtime",
        key: "invalid",
        now: () => 1500,
      }),
    ).toBeNull();
    expect(
      listSqliteAgentCacheEntries({
        env,
        agentId: "main",
        scope: "runtime",
        now: () => 1500,
      }).map((entry) => entry.key),
    ).toEqual(["valid"]);
    expect(
      clearExpiredSqliteAgentCacheEntries({
        env,
        agentId: "main",
        scope: "runtime",
        currentTime: Number.NaN,
      }),
    ).toBe(0);
    expect(
      clearExpiredSqliteAgentCacheEntries({
        env,
        agentId: "main",
        scope: "runtime",
        currentTime: 1500,
      }),
    ).toBe(1);
  });

  it("exposes a scoped runtime cache adapter", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
    const cache = createSqliteAgentCacheStore({
      env,
      agentId: "main",
      scope: "run:adapter",
      now: () => 3000,
    });

    cache.write({
      key: "result",
      value: ["a", "b"],
      blob: Buffer.from([1, 2]),
    });

    expect(cache.read("result")).toEqual(
      expect.objectContaining({
        agentId: "main",
        scope: "run:adapter",
        key: "result",
        value: ["a", "b"],
        blob: Buffer.from([1, 2]),
      }),
    );
    expect(
      deleteSqliteAgentCacheEntry({ env, agentId: "main", scope: "run:adapter", key: "result" }),
    ).toBe(true);
    expect(cache.read("result")).toBeNull();
    cache.write({ key: "next", value: true });
    expect(clearSqliteAgentCacheEntries({ env, agentId: "main", scope: "run:adapter" })).toBe(1);
  });

  it("does not let loose write options override the scoped adapter owner", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
    const cache = createSqliteAgentCacheStore({
      env,
      agentId: "main",
      scope: "safe",
      now: () => 4000,
    });

    cache.write({
      key: "result",
      value: "ok",
      ...({
        agentId: "other",
        scope: "unsafe",
      } as Record<string, unknown>),
    });

    expect(
      readSqliteAgentCacheEntry({ env, agentId: "main", scope: "safe", key: "result" }),
    ).toEqual(expect.objectContaining({ value: "ok" }));
    expect(
      readSqliteAgentCacheEntry({ env, agentId: "other", scope: "unsafe", key: "result" }),
    ).toBeNull();
  });

  it("honors explicit per-agent database paths", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const dbPath = path.join(stateDir, "custom", "worker.sqlite");

    writeSqliteAgentCacheEntry({
      env,
      path: dbPath,
      agentId: "worker",
      scope: "runtime",
      key: "entry",
      value: { ok: true },
    });

    expect(fs.existsSync(dbPath)).toBe(true);
    expect(
      listOpenClawRegisteredAgentDatabases({ env }).find((entry) => entry.path === dbPath),
    ).toMatchObject({
      agentId: "worker",
      path: dbPath,
    });
  });
});
