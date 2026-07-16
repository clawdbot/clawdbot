import path from "node:path";
import { pathToFileURL } from "node:url";
import * as lancedb from "@lancedb/lancedb";
import { expectDefined } from "@openclaw/normalization-core";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor";
import { describe, expect, test } from "vitest";
import {
  createMemoryLanceDbStateMigrations,
  resolveMemoryLanceDbPluginRoot,
  stateMigrations,
} from "./doctor-contract-api.js";
import { installTmpDirHarness } from "./test-helpers.js";

const unusedDoctorContext = {
  openPluginStateKeyedStore() {
    throw new Error("not used by memory-lancedb migration");
  },
} as PluginDoctorStateMigrationContext;

describe("memory-lancedb doctor migration", () => {
  const { getDbPath, getTmpDir } = installTmpDirHarness({
    prefix: "openclaw-memory-doctor-",
  });

  test("assigns legacy shared rows to the configured default agent once", async () => {
    const connection = await lancedb.connect(getDbPath());
    const table = await connection.createTable("memories", [
      {
        id: "11111111-1111-4111-8111-111111111111",
        text: "legacy shared memory",
        vector: [1, 0],
        importance: 0.7,
        category: "fact",
        createdAt: 1,
      },
    ]);
    table.close();
    connection.close();

    const config = {
      agents: { list: [{ id: "Owner Agent", default: true }, { id: "other" }] },
      plugins: {
        entries: {
          "memory-lancedb": {
            config: { dbPath: getDbPath() },
          },
        },
      },
    };
    const params = {
      config,
      env: { ...process.env, HOME: getTmpDir() },
      stateDir: getTmpDir(),
      oauthDir: path.join(getTmpDir(), "oauth"),
      context: unusedDoctorContext,
    };
    const migration = expectDefined(stateMigrations[0], "memory-lancedb state migration");

    await expect(migration.detectLegacyState(params)).resolves.toMatchObject({
      preview: [expect.stringContaining("assign 1 legacy row")],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: ["Assigned 1 legacy Memory LanceDB row to default agent owner-agent"],
      warnings: [],
    });
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();

    const migratedConnection = await lancedb.connect(getDbPath());
    const migratedTable = await migratedConnection.openTable("memories");
    await expect(migratedTable.countRows("agentId = 'owner-agent'")).resolves.toBe(1);
    await expect(migratedTable.countRows("agentId = 'other'")).resolves.toBe(0);
    migratedTable.close();
    migratedConnection.close();
  });

  test("resolves a relative database path from the plugin root", async () => {
    const packageRoot = path.join(getTmpDir(), "standalone-package");
    const packagedDoctorUrl = pathToFileURL(
      path.join(packageRoot, "dist", "doctor-contract-api.js"),
    ).href;
    const pluginRoot = resolveMemoryLanceDbPluginRoot(packagedDoctorUrl);
    expect(pluginRoot).toBe(packageRoot);
    const relativeDbPath = path.join("data", "lancedb");
    const absoluteDbPath = path.join(pluginRoot, relativeDbPath);
    const connection = await lancedb.connect(absoluteDbPath);
    const table = await connection.createTable("memories", [
      {
        id: "22222222-2222-4222-8222-222222222222",
        text: "relative legacy memory",
        vector: [1, 0],
        importance: 0.7,
        category: "fact",
        createdAt: 2,
      },
    ]);
    table.close();
    connection.close();

    const config = {
      agents: { list: [{ id: "main", default: true }] },
      plugins: {
        entries: {
          "memory-lancedb": { config: { dbPath: relativeDbPath } },
        },
      },
    };
    const params = {
      config,
      env: { ...process.env, HOME: getTmpDir() },
      stateDir: getTmpDir(),
      oauthDir: path.join(getTmpDir(), "oauth"),
      context: unusedDoctorContext,
    };
    const migration = expectDefined(
      createMemoryLanceDbStateMigrations(pluginRoot)[0],
      "memory-lancedb state migration",
    );

    await expect(migration.detectLegacyState(params)).resolves.toMatchObject({
      preview: [expect.stringContaining(absoluteDbPath)],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toMatchObject({
      changes: [expect.stringContaining("Assigned 1 legacy Memory LanceDB row")],
    });

    const migratedConnection = await lancedb.connect(absoluteDbPath);
    const migratedTable = await migratedConnection.openTable("memories");
    await expect(migratedTable.countRows("agentId = 'main'")).resolves.toBe(1);
    migratedTable.close();
    migratedConnection.close();
  });
});
