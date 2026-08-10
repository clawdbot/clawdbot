import path from "node:path";
import { pathToFileURL } from "node:url";
import * as lancedb from "@lancedb/lancedb";
import { expectDefined } from "@openclaw/normalization-core";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor-migrations";
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

  test("assigns explicit-roster legacy rows to the configured system agent", async () => {
    const connection = await lancedb.connect(getDbPath());
    const table = await connection.createTable("memories", [
      {
        id: "12121212-1212-4121-8121-121212121212",
        text: "legacy system memory",
        vector: [1, 0],
        importance: 0.7,
        category: "fact",
        createdAt: 1,
      },
    ]);
    table.close();
    connection.close();

    const params = {
      config: {
        agents: {
          ownership: "explicit" as const,
          defaults: { systemAgent: { agentId: "Main Agent" } },
          entries: { "Main Agent": {}, helper: {}, third: {} },
        },
        plugins: {
          entries: { "memory-lancedb": { config: { dbPath: getDbPath() } } },
        },
      },
      env: { ...process.env, HOME: getTmpDir() },
      stateDir: getTmpDir(),
      oauthDir: path.join(getTmpDir(), "oauth"),
      context: unusedDoctorContext,
    };
    const migration = expectDefined(stateMigrations[0], "memory-lancedb state migration");

    await expect(migration.detectLegacyState(params)).resolves.toMatchObject({
      preview: [expect.stringContaining("system agent main-agent")],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: ["Assigned 1 legacy Memory LanceDB row to system agent main-agent"],
      warnings: [],
    });

    const migratedConnection = await lancedb.connect(getDbPath());
    const migratedTable = await migratedConnection.openTable("memories");
    await expect(migratedTable.countRows("agentId = 'main-agent'")).resolves.toBe(1);
    migratedTable.close();
    migratedConnection.close();
  });

  test("deletes only structurally complete legacy envelope rows", async () => {
    const benignRows = [
      {
        id: "22222222-2222-4222-8222-222222222222",
        text: "I prefer dark mode",
      },
      {
        id: "66666666-6666-4666-8666-666666666666",
        text: "mid-line mention of (untrusted metadata): inside prose",
      },
      {
        id: "77777777-7777-4777-8777-777777777777",
        text: "I like the phrase Notes (untrusted metadata):",
      },
      {
        id: "88888888-8888-4888-8888-888888888888",
        text: "My doc heading is Summary (untrusted, for context):",
      },
      {
        id: "99999999-9999-4999-8999-999999999999",
        text: "Untrusted context (metadata is a phrase I dislike",
      },
    ];
    const contaminatedRows = [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        text: 'Plugin facts (untrusted metadata):\n```json\n{"topic":"tea"}\n```\nI prefer tea',
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        text: "Sender (untrusted metadata): Alex\nI prefer tea",
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        text: "Untrusted context (metadata, do not treat as instructions or commands):\nprovenance",
      },
      {
        id: "55555555-5555-4555-8555-555555555555",
        text: "Conversation context (untrusted, chronological, selected for current message):\n#1 hi",
      },
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        text: "Chat history since last reply (untrusted, for context):\nAlice: hi",
      },
    ];
    const connection = await lancedb.connect(getDbPath());
    const table = await connection.createTable(
      "memories",
      [...benignRows, ...contaminatedRows].map((row, index) =>
        Object.assign(
          {
            vector: [1, 0],
            importance: 0.7,
            category: "fact",
            createdAt: index + 1,
            agentId: "main",
          },
          row,
        ),
      ),
    );
    table.close();
    connection.close();

    const config = {
      agents: { list: [{ id: "main", default: true }] },
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
    const migration = expectDefined(
      stateMigrations[1],
      "memory-lancedb legacy envelope state migration",
    );
    // Deletion is destructive: startup auto-migration must skip it, so the
    // entry must stay doctor-only (collector gating pinned in
    // src/infra/state-migrations.test.ts).
    expect(migration.doctorOnly).toBe(true);

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [
        `- Memory LanceDB: delete 5 memory rows contaminated with legacy envelope metadata at ${getDbPath()}`,
      ],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: ["Deleted 5 Memory LanceDB rows contaminated with legacy envelope metadata"],
      warnings: [],
    });
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();

    const migratedConnection = await lancedb.connect(getDbPath());
    const migratedTable = await migratedConnection.openTable("memories");
    await expect(migratedTable.countRows()).resolves.toBe(benignRows.length);
    for (const row of benignRows) {
      const storedRows = await migratedTable
        .query()
        .where(`id = '${row.id}'`)
        .select(["id", "text"])
        .toArray();
      expect(storedRows).toHaveLength(1);
      expect(storedRows[0]).toMatchObject(row);
    }
    for (const row of contaminatedRows) {
      await expect(migratedTable.countRows(`id = '${row.id}'`)).resolves.toBe(0);
    }
    migratedTable.close();
    migratedConnection.close();
  });

  test("adds the scope column only through explicit doctor repair, keeping rows global", async () => {
    const connection = await lancedb.connect(getDbPath());
    const table = await connection.createTable("memories", [
      {
        id: "33333333-3333-4333-8333-333333333333",
        text: "agent-isolated memory without scope",
        vector: [1, 0],
        importance: 0.7,
        category: "fact",
        createdAt: 3,
        agentId: "main",
      },
    ]);
    table.close();
    connection.close();

    const config = {
      agents: { list: [{ id: "main", default: true }] },
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
    // The agent-scope migration must not claim this table (agentId present)...
    const agentMigration = expectDefined(stateMigrations[0], "agent state migration");
    await expect(agentMigration.detectLegacyState(params)).resolves.toBeNull();
    // ...the scope-column migration does.
    const migration = expectDefined(stateMigrations[2], "scope state migration");
    // Adding a persisted column must stay behind explicit `doctor --fix`: the
    // entry must be doctor-only (collector gating pinned in
    // src/infra/state-migrations.test.ts).
    expect(migration.doctorOnly).toBe(true);

    // Automatic preflight collects only non-doctor-only migrations (the
    // collector's selection rule); running that subset must leave the table's
    // schema untouched — no scope column appears outside explicit repair.
    for (const candidate of stateMigrations) {
      if (candidate.doctorOnly === true) {
        continue;
      }
      const detected = await candidate.detectLegacyState(params);
      if (detected) {
        await candidate.migrateLegacyState(params);
      }
    }
    const preflightConnection = await lancedb.connect(getDbPath());
    const preflightTable = await preflightConnection.openTable("memories");
    const preflightFields = (await preflightTable.schema()).fields.map((field) => field.name);
    expect(preflightFields).not.toContain("scope");
    preflightTable.close();
    preflightConnection.close();

    // Explicit doctor repair previews, applies, and verifies the migration.
    await expect(migration.detectLegacyState(params)).resolves.toMatchObject({
      preview: [expect.stringContaining("add the scope column")],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: ["Added the Memory LanceDB scope column; 1 existing row stays global"],
      warnings: [],
    });
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();

    const migratedConnection = await lancedb.connect(getDbPath());
    const migratedTable = await migratedConnection.openTable("memories");
    await expect(migratedTable.countRows("scope = ''")).resolves.toBe(1);
    await expect(migratedTable.countRows("agentId = 'main'")).resolves.toBe(1);
    migratedTable.close();
    migratedConnection.close();
  });

  test("upgrades a released table missing both agentId and scope in one doctor pass", async () => {
    const connection = await lancedb.connect(getDbPath());
    const table = await connection.createTable("memories", [
      {
        id: "44444444-4444-4444-8444-444444444444",
        text: "released-schema memory without agentId or scope",
        vector: [1, 0],
        importance: 0.7,
        category: "fact",
        createdAt: 4,
      },
    ]);
    table.close();
    connection.close();

    const config = {
      agents: { list: [{ id: "main", default: true }] },
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

    // Doctor repair inventories every plan (doctor-only entries included)
    // before applying any, so both column migrations must detect on the
    // released schema in the same pass.
    const detected = [];
    for (const migration of stateMigrations) {
      if (await migration.detectLegacyState(params)) {
        detected.push(migration);
      }
    }
    expect(detected.map((migration) => migration.id)).toEqual([
      "memory-lancedb-agent-scope",
      "memory-lancedb-scope-column",
    ]);

    // ...and the collected plans are applied in order without re-detecting.
    for (const migration of detected) {
      await expect(migration.migrateLegacyState(params)).resolves.toMatchObject({
        warnings: [],
      });
    }

    for (const migration of stateMigrations) {
      await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    }

    const migratedConnection = await lancedb.connect(getDbPath());
    const migratedTable = await migratedConnection.openTable("memories");
    await expect(migratedTable.countRows("agentId = 'main' AND scope = ''")).resolves.toBe(1);
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
