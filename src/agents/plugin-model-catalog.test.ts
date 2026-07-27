// Generated plugin catalogs reuse the existing per-agent SQLite cache.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  decodePluginModelCatalogRelativePathPluginId,
  encodePluginModelCatalogRelativePath,
  loadPersistedPluginModelCatalogs,
  migrateLegacyPluginModelCatalogs,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
} from "./plugin-model-catalog.js";

function listPersistedPluginModelCatalogs(agentDir: string) {
  return loadPersistedPluginModelCatalogs(agentDir).catalogs;
}

const tempDirs: string[] = [];

function createAgentDir(): string {
  const agentDir = mkdtempSync(join(tmpdir(), "openclaw-plugin-model-catalog-"));
  tempDirs.push(agentDir);
  return agentDir;
}

function catalogContents(provider: string, apiKey?: string): string {
  return JSON.stringify({
    generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
    providers: {
      [provider]: {
        baseUrl: `https://${provider}.example/v1`,
        api: "openai-completions",
        ...(apiKey ? { apiKey } : {}),
        models: [{ id: `${provider}-model`, name: `${provider} model` }],
      },
    },
  });
}

function readCatalogCacheRow(
  agentDir: string,
  pluginId: string,
): {
  value_json: string;
  updated_at: number;
} {
  const database = new DatabaseSync(join(agentDir, "openclaw-agent.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare("SELECT value_json, updated_at FROM cache_entries WHERE scope = ? AND key = ?")
      .get("plugin-model-catalog-v1", pluginId) as
      | { value_json: string; updated_at: number }
      | undefined;
    if (!row) {
      throw new Error(`Missing generated catalog cache row for ${pluginId}`);
    }
    return row;
  } finally {
    database.close();
  }
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  for (const agentDir of tempDirs.splice(0)) {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

describe("SQLite-backed plugin model catalogs", () => {
  it("removes generated model rows whose API semantics cannot be derived", () => {
    const agentDir = createAgentDir();
    const relativePath = encodePluginModelCatalogRelativePath("nvidia");
    replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [relativePath]: JSON.stringify({
          generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
          providers: {
            nvidia: {
              baseUrl: "https://integrate.api.nvidia.com/v1",
              apiKey: "NVIDIA_API_KEY",
              models: [
                { id: "meta-llama/llama-3.3-70b-instruct" },
                { id: "model-owned-api", api: "openai-completions" },
              ],
            },
          },
        }),
      },
    });

    const persisted = listPersistedPluginModelCatalogs(agentDir);
    expect(persisted).toHaveLength(1);
    const catalog = JSON.parse(persisted[0]?.contents ?? "{}") as {
      providers?: {
        nvidia?: { api?: string; apiKey?: string; models?: Array<{ id?: string; api?: string }> };
      };
    };
    expect(catalog.providers?.nvidia).toMatchObject({
      apiKey: "NVIDIA_API_KEY",
      models: [{ id: "model-owned-api", api: "openai-completions" }],
    });
    expect(catalog.providers?.nvidia).not.toHaveProperty("api");
  });

  it("repairs malformed persisted catalogs once without touching valid siblings", () => {
    const agentDir = createAgentDir();
    const validNvidia = catalogContents("nvidia", "NVIDIA_API_KEY");
    const validZai = catalogContents("zai", "ZAI_API_KEY");
    replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("nvidia")]: validNvidia,
        [encodePluginModelCatalogRelativePath("zai")]: validZai,
      },
    });
    const malformedNvidia = JSON.stringify({
      generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
      providers: {
        nvidia: {
          baseUrl: "https://integrate.api.nvidia.com/v1",
          apiKey: "NVIDIA_API_KEY",
          models: [{ id: "meta-llama/llama-3.3-70b-instruct" }],
        },
      },
    });
    const database = new DatabaseSync(join(agentDir, "openclaw-agent.sqlite"));
    try {
      database
        .prepare(
          "UPDATE cache_entries SET value_json = ?, updated_at = 42 WHERE scope = ? AND key = ?",
        )
        .run(malformedNvidia, "plugin-model-catalog-v1", "nvidia");
    } finally {
      database.close();
    }

    const firstLoad = listPersistedPluginModelCatalogs(agentDir);
    const repairedNvidia = JSON.parse(
      firstLoad.find((catalog) => catalog.pluginId === "nvidia")?.contents ?? "{}",
    ) as {
      providers?: { nvidia?: { api?: string; apiKey?: string; models?: unknown[] } };
    };
    expect(repairedNvidia.providers?.nvidia).toMatchObject({
      apiKey: "NVIDIA_API_KEY",
      models: [],
    });
    expect(repairedNvidia.providers?.nvidia).not.toHaveProperty("api");
    expect(firstLoad.find((catalog) => catalog.pluginId === "zai")?.contents).toBe(validZai);

    const repairedRow = readCatalogCacheRow(agentDir, "nvidia");
    expect(repairedRow.updated_at).not.toBe(42);
    const secondLoad = listPersistedPluginModelCatalogs(agentDir);
    expect(secondLoad).toEqual(firstLoad);
    expect(readCatalogCacheRow(agentDir, "nvidia")).toEqual(repairedRow);
  });

  it("re-reads a concurrent refresh that wins the repair compare-and-set", () => {
    const agentDir = createAgentDir();
    const relativePath = encodePluginModelCatalogRelativePath("nvidia");
    const refreshed = catalogContents("nvidia", "concurrently-refreshed-provider-test-key");
    replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: { [relativePath]: refreshed },
    });
    const malformed = JSON.stringify({
      generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
      providers: {
        nvidia: {
          baseUrl: "https://integrate.api.nvidia.com/v1",
          apiKey: "NVIDIA_API_KEY",
          models: [{ id: "meta-llama/llama-3.3-70b-instruct" }],
        },
      },
    });
    const database = new DatabaseSync(join(agentDir, "openclaw-agent.sqlite"));
    try {
      database
        .prepare(
          "UPDATE cache_entries SET value_json = ?, updated_at = 42 WHERE scope = ? AND key = ?",
        )
        .run(malformed, "plugin-model-catalog-v1", "nvidia");
      database.exec("CREATE TABLE catalog_repair_refresh (value_json TEXT NOT NULL)");
      database.prepare("INSERT INTO catalog_repair_refresh (value_json) VALUES (?)").run(refreshed);
      database.exec(`
        CREATE TRIGGER refresh_catalog_before_repair
        BEFORE UPDATE OF value_json ON cache_entries
        WHEN OLD.scope = 'plugin-model-catalog-v1'
          AND OLD.key = 'nvidia'
          AND NEW.value_json != (SELECT value_json FROM catalog_repair_refresh)
        BEGIN
          UPDATE cache_entries
          SET value_json = (SELECT value_json FROM catalog_repair_refresh), updated_at = 99
          WHERE scope = OLD.scope AND key = OLD.key;
          SELECT RAISE(IGNORE);
        END
      `);
    } finally {
      database.close();
    }

    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([
      { pluginId: "nvidia", contents: refreshed },
    ]);
    expect(readCatalogCacheRow(agentDir, "nvidia")).toEqual({
      value_json: refreshed,
      updated_at: 99,
    });
  });

  it("does not create an agent database for a read-only cache miss", () => {
    const agentDir = createAgentDir();

    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([]);
    expect(existsSync(join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
    expect(existsSync(join(agentDir, "plugins"))).toBe(false);
  });

  it("does not create agent state when an empty catalog is already current", () => {
    const agentDir = createAgentDir();

    expect(replacePersistedPluginModelCatalogs({ agentDir, pluginCatalogWrites: {} })).toBe(false);
    expect(existsSync(join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
    expect(existsSync(join(agentDir, "plugins"))).toBe(false);
  });

  it("automatically migrates a released catalog before the first SQLite read", () => {
    const agentDir = createAgentDir();
    const contents = catalogContents("zai", "released-provider-test-key");
    const sourcePath = join(agentDir, encodePluginModelCatalogRelativePath("zai"));
    mkdirSync(join(agentDir, "plugins", "zai"), { recursive: true });
    writeFileSync(sourcePath, contents, "utf8");

    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([{ pluginId: "zai", contents }]);
    expect(existsSync(join(agentDir, "openclaw-agent.sqlite"))).toBe(true);
    expect(existsSync(sourcePath)).toBe(false);
  });

  it("retires migrated credential recovery data after verifying the canonical catalog", () => {
    const agentDir = createAgentDir();
    const contents = catalogContents("zai", "retired-released-provider-test-key");
    const sourcePath = join(agentDir, encodePluginModelCatalogRelativePath("zai"));
    mkdirSync(join(agentDir, "plugins", "zai"), { recursive: true });
    writeFileSync(sourcePath, contents, "utf8");

    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([{ pluginId: "zai", contents }]);
    const database = new DatabaseSync(join(agentDir, "openclaw-agent.sqlite"), {
      readOnly: true,
    });
    try {
      expect(
        database
          .prepare("SELECT value_json FROM cache_entries WHERE scope = ?")
          .all("plugin-model-catalog-migration-v1"),
      ).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("retires an orphaned recovery credential after an interrupted migration", () => {
    const agentDir = createAgentDir();
    const contents = catalogContents("zai", "interrupted-released-provider-test-key");
    replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("zai")]: contents,
      },
    });
    const database = new DatabaseSync(join(agentDir, "openclaw-agent.sqlite"));
    try {
      database
        .prepare(
          "INSERT INTO cache_entries (scope, key, value_json, blob, expires_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?)",
        )
        .run("plugin-model-catalog-migration-v1", "zai", contents, Date.now());
    } finally {
      database.close();
    }

    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([{ pluginId: "zai", contents }]);
    const verified = new DatabaseSync(join(agentDir, "openclaw-agent.sqlite"), {
      readOnly: true,
    });
    try {
      expect(
        verified
          .prepare("SELECT value_json FROM cache_entries WHERE scope = ?")
          .all("plugin-model-catalog-migration-v1"),
      ).toEqual([]);
    } finally {
      verified.close();
    }
  });

  it("protects migration recovery credentials when a plugin directory cannot be inspected", () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const agentDir = createAgentDir();
    const contents = catalogContents("zai", "protected-released-provider-test-key");
    const pluginDir = join(agentDir, "plugins", "zai");
    replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("zai")]: contents,
      },
    });
    const database = new DatabaseSync(join(agentDir, "openclaw-agent.sqlite"));
    try {
      database
        .prepare(
          "INSERT INTO cache_entries (scope, key, value_json, blob, expires_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?)",
        )
        .run("plugin-model-catalog-migration-v1", "zai", contents, Date.now());
    } finally {
      database.close();
    }
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "catalog.json"), contents, "utf8");
    chmodSync(pluginDir, 0o000);

    try {
      expect(migrateLegacyPluginModelCatalogs({ agentDir })).toEqual({
        detected: 0,
        migrated: 0,
        warnings: [expect.stringContaining("Could not inspect legacy provider catalogs")],
      });
      const verified = new DatabaseSync(join(agentDir, "openclaw-agent.sqlite"), {
        readOnly: true,
      });
      try {
        expect(
          verified
            .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
            .all("plugin-model-catalog-migration-v1", "zai"),
        ).toEqual([{ value_json: contents }]);
      } finally {
        verified.close();
      }
    } finally {
      chmodSync(pluginDir, 0o700);
    }

    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([{ pluginId: "zai", contents }]);
  });

  it("detects a released catalog that appears after an earlier empty scan", () => {
    const agentDir = createAgentDir();
    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([]);

    const contents = catalogContents("zai", "late-released-provider-test-key");
    const sourcePath = join(agentDir, encodePluginModelCatalogRelativePath("zai"));
    mkdirSync(join(agentDir, "plugins", "zai"), { recursive: true });
    writeFileSync(sourcePath, contents, "utf8");

    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([{ pluginId: "zai", contents }]);
    expect(existsSync(sourcePath)).toBe(false);
  });

  it("migrates a later provider catalog after an earlier migration completed", () => {
    const agentDir = createAgentDir();
    const zai = catalogContents("zai", "released-zai-provider-test-key");
    const zaiPath = join(agentDir, encodePluginModelCatalogRelativePath("zai"));
    mkdirSync(join(agentDir, "plugins", "zai"), { recursive: true });
    writeFileSync(zaiPath, zai, "utf8");

    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([
      { pluginId: "zai", contents: zai },
    ]);

    const anthropic = catalogContents("anthropic", "late-anthropic-provider-test-key");
    const anthropicPath = join(agentDir, encodePluginModelCatalogRelativePath("anthropic"));
    mkdirSync(join(agentDir, "plugins", "anthropic"), { recursive: true });
    writeFileSync(anthropicPath, anthropic, "utf8");

    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([
      { pluginId: "anthropic", contents: anthropic },
      { pluginId: "zai", contents: zai },
    ]);
    expect(existsSync(zaiPath)).toBe(false);
    expect(existsSync(anthropicPath)).toBe(false);
  });

  it("migrates a changed later sidecar for an already migrated provider", () => {
    const agentDir = createAgentDir();
    const pluginDir = join(agentDir, "plugins", "zai");
    const sourcePath = join(agentDir, encodePluginModelCatalogRelativePath("zai"));
    const original = catalogContents("zai", "first-released-provider-test-key");
    const later = catalogContents("zai", "later-released-provider-test-key");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(sourcePath, original, "utf8");
    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([
      { pluginId: "zai", contents: original },
    ]);

    writeFileSync(sourcePath, later, "utf8");

    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([
      { pluginId: "zai", contents: later },
    ]);
    expect(existsSync(sourcePath)).toBe(false);
  });

  it("preserves released credentials and unrelated regenerated SQLite catalogs", () => {
    const agentDir = createAgentDir();
    const regenerated = catalogContents("zai", "regenerated-provider-test-key");
    const released = catalogContents("zai", "released-provider-test-key");
    const unrelated = catalogContents("anthropic", "unrelated-provider-test-key");
    replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("zai")]: regenerated,
        [encodePluginModelCatalogRelativePath("anthropic")]: unrelated,
      },
    });
    const sourcePath = join(agentDir, encodePluginModelCatalogRelativePath("zai"));
    mkdirSync(join(agentDir, "plugins", "zai"), { recursive: true });
    writeFileSync(sourcePath, released, "utf8");

    expect(
      migrateLegacyPluginModelCatalogs({
        agentDir,
        expectedContents: new Map([["zai", released]]),
      }),
    ).toEqual({ detected: 1, migrated: 1, warnings: [] });
    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([
      { pluginId: "anthropic", contents: unrelated },
      { pluginId: "zai", contents: released },
    ]);
    expect(existsSync(sourcePath)).toBe(false);
  });

  it("recovers a released sidecar that appears after a catalog replacement was planned", () => {
    const agentDir = createAgentDir();
    const released = catalogContents("zai", "released-provider-test-key");
    const preplanned = catalogContents("zai", "preplanned-provider-test-key");
    const sourcePath = join(agentDir, encodePluginModelCatalogRelativePath("zai"));
    mkdirSync(join(agentDir, "plugins", "zai"), { recursive: true });
    writeFileSync(sourcePath, released, "utf8");

    replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("zai")]: preplanned,
      },
    });

    expect(existsSync(sourcePath)).toBe(true);
    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([
      { pluginId: "zai", contents: released },
    ]);
    expect(existsSync(sourcePath)).toBe(false);
  });

  it("treats an already-completed legacy migration as safe to repeat", () => {
    const agentDir = createAgentDir();
    const contents = catalogContents("zai", "released-provider-test-key");
    const sourcePath = join(agentDir, encodePluginModelCatalogRelativePath("zai"));
    mkdirSync(join(agentDir, "plugins", "zai"), { recursive: true });
    writeFileSync(sourcePath, contents, "utf8");

    expect(migrateLegacyPluginModelCatalogs({ agentDir })).toEqual({
      detected: 1,
      migrated: 1,
      warnings: [],
    });
    expect(migrateLegacyPluginModelCatalogs({ agentDir })).toEqual({
      detected: 0,
      migrated: 0,
      warnings: [],
    });
    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([{ pluginId: "zai", contents }]);
  });

  it("accepts a sidecar already migrated and removed by another process", () => {
    const agentDir = createAgentDir();
    const contents = catalogContents("zai", "concurrently-migrated-provider-test-key");
    replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("zai")]: contents,
      },
    });

    expect(
      migrateLegacyPluginModelCatalogs({
        agentDir,
        expectedContents: new Map([["zai", contents]]),
      }),
    ).toEqual({ detected: 0, migrated: 0, warnings: [] });
    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([{ pluginId: "zai", contents }]);
  });

  it("keeps committed catalogs available when a released sidecar cannot be removed", () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const agentDir = createAgentDir();
    const contents = catalogContents("zai", "released-provider-test-key");
    const pluginDir = join(agentDir, "plugins", "zai");
    const sourcePath = join(agentDir, encodePluginModelCatalogRelativePath("zai"));
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(sourcePath, contents, "utf8");
    chmodSync(pluginDir, 0o500);

    try {
      expect(migrateLegacyPluginModelCatalogs({ agentDir })).toEqual({
        detected: 1,
        migrated: 0,
        warnings: [expect.stringContaining("Could not remove migrated legacy provider catalog")],
      });
      expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([{ pluginId: "zai", contents }]);
      expect(existsSync(sourcePath)).toBe(true);

      const refreshed = catalogContents("zai", "refreshed-provider-test-key");
      replacePersistedPluginModelCatalogs({
        agentDir,
        pluginCatalogWrites: {
          [encodePluginModelCatalogRelativePath("zai")]: refreshed,
        },
      });
      expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([
        { pluginId: "zai", contents: refreshed },
      ]);
      expect(existsSync(sourcePath)).toBe(true);
    } finally {
      chmodSync(pluginDir, 0o700);
    }
  });

  it("never deletes retained migrated credentials after a newer catalog replaces them", () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const agentDir = createAgentDir();
    const original = catalogContents("zai", "released-provider-test-key");
    const refreshed = catalogContents("zai", "refreshed-provider-test-key");
    const pluginDir = join(agentDir, "plugins", "zai");
    const sourcePath = join(agentDir, encodePluginModelCatalogRelativePath("zai"));
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(sourcePath, original, "utf8");
    chmodSync(pluginDir, 0o500);

    try {
      expect(migrateLegacyPluginModelCatalogs({ agentDir })).toEqual({
        detected: 1,
        migrated: 0,
        warnings: [expect.stringContaining("Could not remove migrated legacy provider catalog")],
      });
      replacePersistedPluginModelCatalogs({
        agentDir,
        pluginCatalogWrites: {
          [encodePluginModelCatalogRelativePath("zai")]: refreshed,
        },
      });
    } finally {
      chmodSync(pluginDir, 0o700);
    }

    expect(migrateLegacyPluginModelCatalogs({ agentDir })).toEqual({
      detected: 1,
      migrated: 0,
      warnings: [expect.stringContaining("Left superseded legacy provider catalog in place")],
    });
    expect(existsSync(sourcePath)).toBe(true);
    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([
      { pluginId: "zai", contents: refreshed },
    ]);
    expect(existsSync(sourcePath)).toBe(true);
  });

  it("atomically preserves a provider catalog refreshed immediately before migration claims it", () => {
    const agentDir = createAgentDir();
    const original = catalogContents("zai", "released-provider-test-key");
    const refreshed = catalogContents("zai", "concurrently-refreshed-provider-test-key");
    const sourcePath = join(agentDir, encodePluginModelCatalogRelativePath("zai"));
    mkdirSync(join(agentDir, "plugins", "zai"), { recursive: true });
    writeFileSync(sourcePath, original, "utf8");

    expect(
      migrateLegacyPluginModelCatalogs({
        agentDir,
        beforeLegacyCatalogClaim: (pathname) => {
          writeFileSync(pathname, refreshed, "utf8");
        },
      }),
    ).toEqual({
      detected: 1,
      migrated: 0,
      warnings: [expect.stringContaining("Left changed legacy provider catalog in place")],
    });
    expect(readFileSync(sourcePath, "utf8")).toBe(refreshed);
    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([
      { pluginId: "zai", contents: refreshed },
    ]);
    expect(existsSync(sourcePath)).toBe(false);
  });

  it("never publishes a stale scan after another process removes the legacy source", () => {
    const agentDir = createAgentDir();
    const original = catalogContents("zai", "stale-released-provider-test-key");
    const refreshed = catalogContents("zai", "current-regenerated-provider-test-key");
    const sourcePath = join(agentDir, encodePluginModelCatalogRelativePath("zai"));
    mkdirSync(join(agentDir, "plugins", "zai"), { recursive: true });
    writeFileSync(sourcePath, original, "utf8");

    expect(
      migrateLegacyPluginModelCatalogs({
        agentDir,
        beforeLegacyCatalogClaim: (pathname) => {
          replacePersistedPluginModelCatalogs({
            agentDir,
            pluginCatalogWrites: {
              [encodePluginModelCatalogRelativePath("zai")]: refreshed,
            },
          });
          unlinkSync(pathname);
        },
      }),
    ).toEqual({
      detected: 1,
      migrated: 0,
      warnings: [
        expect.stringContaining(
          "Legacy provider catalog was claimed before its migration was committed",
        ),
      ],
    });
    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([
      { pluginId: "zai", contents: refreshed },
    ]);
  });

  it("blocks preparation until another process commits its claimed provider catalog", () => {
    const agentDir = createAgentDir();
    const contents = catalogContents("zai", "in-flight-released-provider-test-key");
    const sourcePath = join(agentDir, encodePluginModelCatalogRelativePath("zai"));
    const claimPath = `${sourcePath}.doctor-importing-concurrent-process`;
    mkdirSync(join(agentDir, "plugins", "zai"), { recursive: true });
    writeFileSync(sourcePath, contents, "utf8");

    expect(
      migrateLegacyPluginModelCatalogs({
        agentDir,
        beforeLegacyCatalogClaim: (pathname) => {
          renameSync(pathname, claimPath);
        },
      }),
    ).toEqual({
      detected: 1,
      migrated: 0,
      warnings: [
        expect.stringContaining(
          "Legacy provider catalog was claimed before its migration was committed",
        ),
      ],
    });
    expect(existsSync(claimPath)).toBe(true);
    expect(existsSync(join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([{ pluginId: "zai", contents }]);
    expect(existsSync(claimPath)).toBe(false);
  });

  it("never migrates a provider while one retained claim cannot be read", () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const agentDir = createAgentDir();
    const pluginDir = join(agentDir, "plugins", "zai");
    const claimPath = join(pluginDir, "catalog.json.doctor-importing-previous-process");
    const sourcePath = join(pluginDir, "catalog.json");
    const retained = catalogContents("zai", "unreadable-retained-provider-test-key");
    const refreshed = catalogContents("zai", "current-canonical-provider-test-key");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(claimPath, retained, "utf8");
    writeFileSync(sourcePath, refreshed, "utf8");
    chmodSync(claimPath, 0o000);

    try {
      expect(migrateLegacyPluginModelCatalogs({ agentDir })).toEqual({
        detected: 0,
        migrated: 0,
        warnings: [expect.stringContaining("Could not read legacy provider catalog")],
      });
      expect(existsSync(claimPath)).toBe(true);
      expect(existsSync(sourcePath)).toBe(true);
      expect(existsSync(join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
    } finally {
      chmodSync(claimPath, 0o600);
    }

    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([
      { pluginId: "zai", contents: refreshed },
    ]);
  });

  it("recovers a retained atomic migration claim after an interrupted upgrade", () => {
    const agentDir = createAgentDir();
    const contents = catalogContents("zai", "interrupted-released-provider-test-key");
    const pluginDir = join(agentDir, "plugins", "zai");
    const claimPath = join(pluginDir, "catalog.json.doctor-importing-previous-process");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(claimPath, contents, "utf8");

    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([{ pluginId: "zai", contents }]);
    expect(existsSync(claimPath)).toBe(false);
  });

  it("recovers a retained claim before applying a newer canonical provider catalog", () => {
    const agentDir = createAgentDir();
    const retained = catalogContents("zai", "interrupted-released-provider-test-key");
    const refreshed = catalogContents("zai", "concurrently-refreshed-provider-test-key");
    const pluginDir = join(agentDir, "plugins", "zai");
    const sourcePath = join(pluginDir, "catalog.json");
    const claimPath = join(pluginDir, "catalog.json.doctor-importing-previous-process");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(claimPath, retained, "utf8");
    writeFileSync(sourcePath, refreshed, "utf8");

    expect(migrateLegacyPluginModelCatalogs({ agentDir })).toEqual({
      detected: 2,
      migrated: 2,
      warnings: [],
    });
    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([
      { pluginId: "zai", contents: refreshed },
    ]);
    expect(existsSync(claimPath)).toBe(false);
    expect(existsSync(sourcePath)).toBe(false);
  });

  it("preserves conflicting retained claims without guessing which credential is newer", () => {
    const agentDir = createAgentDir();
    const pluginDir = join(agentDir, "plugins", "zai");
    const olderPath = join(pluginDir, "catalog.json.doctor-importing-zzz");
    const newerPath = join(pluginDir, "catalog.json.doctor-importing-aaa");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(olderPath, catalogContents("zai", "older-provider-test-key"), "utf8");
    writeFileSync(newerPath, catalogContents("zai", "newer-provider-test-key"), "utf8");

    expect(migrateLegacyPluginModelCatalogs({ agentDir })).toEqual({
      detected: 0,
      migrated: 0,
      warnings: [expect.stringContaining("Conflicting retained legacy provider catalogs")],
    });
    expect(existsSync(olderPath)).toBe(true);
    expect(existsSync(newerPath)).toBe(true);
    expect(existsSync(join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
  });

  it("does not let an unreadable sidecar hide other committed provider catalogs", () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const agentDir = createAgentDir();
    const anthropic = catalogContents("anthropic", "available-anthropic-provider-test-key");
    replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("anthropic")]: anthropic,
      },
    });
    const pluginDir = join(agentDir, "plugins", "zai");
    const sourcePath = join(agentDir, encodePluginModelCatalogRelativePath("zai"));
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(sourcePath, catalogContents("zai", "unreadable-provider-test-key"), "utf8");
    chmodSync(sourcePath, 0o000);

    try {
      expect(migrateLegacyPluginModelCatalogs({ agentDir })).toEqual({
        detected: 0,
        migrated: 0,
        warnings: [expect.stringContaining("Could not read legacy provider catalog")],
      });
      expect(loadPersistedPluginModelCatalogs(agentDir)).toEqual({
        catalogs: [{ pluginId: "anthropic", contents: anthropic }],
        warnings: [expect.stringContaining("Could not read legacy provider catalog")],
      });
      expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([
        { pluginId: "anthropic", contents: anthropic },
      ]);
    } finally {
      chmodSync(sourcePath, 0o600);
    }
  });

  it("never migrates or deletes an unmarked user-authored catalog", () => {
    const agentDir = createAgentDir();
    const sourcePath = join(agentDir, encodePluginModelCatalogRelativePath("zai"));
    const contents = JSON.stringify({ providers: { zai: { apiKey: "user-authored-test-key" } } });
    mkdirSync(join(agentDir, "plugins", "zai"), { recursive: true });
    writeFileSync(sourcePath, contents, "utf8");

    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([]);
    expect(existsSync(join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
    expect(existsSync(sourcePath)).toBe(true);
  });

  it("persists provider-owned catalogs in deterministic SQLite order", () => {
    const agentDir = createAgentDir();
    const zai = catalogContents("zai");
    const anthropic = catalogContents("anthropic");

    expect(
      replacePersistedPluginModelCatalogs({
        agentDir,
        pluginCatalogWrites: {
          [encodePluginModelCatalogRelativePath("zai")]: zai,
          [encodePluginModelCatalogRelativePath("anthropic")]: anthropic,
        },
      }),
    ).toBe(true);

    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([
      { pluginId: "anthropic", contents: anthropic },
      { pluginId: "zai", contents: zai },
    ]);
    expect(existsSync(join(agentDir, "openclaw-agent.sqlite"))).toBe(true);
    expect(existsSync(join(agentDir, "plugins"))).toBe(false);
  });

  it("recognizes unchanged payloads and atomically removes stale provider rows", () => {
    const agentDir = createAgentDir();
    const zai = catalogContents("zai");
    const anthropic = catalogContents("anthropic");
    const both = {
      [encodePluginModelCatalogRelativePath("zai")]: zai,
      [encodePluginModelCatalogRelativePath("anthropic")]: anthropic,
    };

    expect(replacePersistedPluginModelCatalogs({ agentDir, pluginCatalogWrites: both })).toBe(true);
    expect(replacePersistedPluginModelCatalogs({ agentDir, pluginCatalogWrites: both })).toBe(
      false,
    );
    expect(
      replacePersistedPluginModelCatalogs({
        agentDir,
        pluginCatalogWrites: {
          [encodePluginModelCatalogRelativePath("zai")]: zai,
        },
      }),
    ).toBe(true);
    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([
      { pluginId: "zai", contents: zai },
    ]);
  });

  it("rejects invalid planning keys without deleting the committed catalog", () => {
    const agentDir = createAgentDir();
    const zai = catalogContents("zai");
    replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("zai")]: zai,
      },
    });

    expect(() =>
      replacePersistedPluginModelCatalogs({
        agentDir,
        pluginCatalogWrites: { "../catalog.json": catalogContents("anthropic") },
      }),
    ).toThrow("Invalid generated plugin model catalog key: ../catalog.json");
    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([
      { pluginId: "zai", contents: zai },
    ]);
  });

  it("round-trips encoded plugin ownership without filesystem discovery", () => {
    const pluginId = "provider/with spaces";
    const key = encodePluginModelCatalogRelativePath(pluginId);

    expect(key).toBe("plugins/provider%2Fwith%20spaces/catalog.json");
    expect(decodePluginModelCatalogRelativePathPluginId(key)).toBe(pluginId);
    expect(decodePluginModelCatalogRelativePathPluginId("../catalog.json")).toBeUndefined();
  });
});
