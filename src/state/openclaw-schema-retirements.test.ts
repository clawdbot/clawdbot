import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import retirementManifest from "./openclaw-schema-retirements.json" with { type: "json" };
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";

type DatabaseOwner = "state" | "agent";
type RetirementStatus = "planned" | "completed";

type SchemaRetirement = {
  database: DatabaseOwner;
  status: RetirementStatus;
  targetVersion: number;
  table: string;
  indexes: string[];
  note?: string;
};

function assertInvariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function parseString(value: unknown, field: string): string {
  assertInvariant(typeof value === "string" && value.length > 0, `${field} must be a string`);
  return value;
}

function parseStringArray(value: unknown, field: string): string[] {
  assertInvariant(Array.isArray(value), `${field} must be an array`);
  return value.map((entry, index) => parseString(entry, `${field}[${index}]`));
}

function parseRetirement(value: unknown, index: number): SchemaRetirement {
  assertInvariant(isRecord(value), `retirements[${index}] must be an object`);
  assertInvariant(
    value.database === "state" || value.database === "agent",
    `retirements[${index}].database must name a database owner`,
  );
  assertInvariant(
    value.status === "planned" || value.status === "completed",
    `retirements[${index}].status must be planned or completed`,
  );
  assertInvariant(
    Number.isInteger(value.targetVersion) && Number(value.targetVersion) >= 0,
    `retirements[${index}].targetVersion must be a non-negative integer`,
  );
  assertInvariant(
    value.note === undefined || typeof value.note === "string",
    `retirements[${index}].note must be a string when present`,
  );

  return {
    database: value.database,
    status: value.status,
    targetVersion: Number(value.targetVersion),
    table: parseString(value.table, `retirements[${index}].table`),
    indexes: parseStringArray(value.indexes, `retirements[${index}].indexes`),
    note: value.note,
  };
}

function parseRetirementManifest(value: unknown): SchemaRetirement[] {
  assertInvariant(isRecord(value), "retirement manifest must be an object");
  assertInvariant(Array.isArray(value.retirements), "retirements must be an array");
  return value.retirements.map(parseRetirement);
}

function assertUniqueRetirements(retirements: readonly SchemaRetirement[]): void {
  const seen = new Set<string>();
  for (const retirement of retirements) {
    const key = `${retirement.database}/${retirement.table}`;
    assertInvariant(!seen.has(key), `duplicate schema retirement: ${key}`);
    seen.add(key);
  }
}

function hasSchemaObject(database: DatabaseSync, type: "table" | "index", name: string): boolean {
  return (
    database.prepare("SELECT 1 FROM sqlite_schema WHERE type = ? AND name = ?").get(type, name) !==
    undefined
  );
}

it("keeps the schema retirement ledger aligned with canonical database schemas", () => {
  const retirements = parseRetirementManifest(retirementManifest);
  assertUniqueRetirements(retirements);

  const databases = {
    state: {
      currentVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      schemaUrl: new URL("./openclaw-state-schema.sql", import.meta.url),
      database: new DatabaseSync(":memory:"),
    },
    agent: {
      currentVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
      schemaUrl: new URL("./openclaw-agent-schema.sql", import.meta.url),
      database: new DatabaseSync(":memory:"),
    },
  } satisfies Record<
    DatabaseOwner,
    { currentVersion: number; schemaUrl: URL; database: DatabaseSync }
  >;

  try {
    for (const database of Object.values(databases)) {
      database.database.exec(readFileSync(database.schemaUrl, "utf8"));
    }

    for (const retirement of retirements) {
      const { currentVersion, database } = databases[retirement.database];
      const shouldExist = retirement.status === "planned";

      if (shouldExist) {
        expect(retirement.targetVersion).toBe(currentVersion + 1);
      } else {
        expect(retirement.targetVersion).toBeLessThanOrEqual(currentVersion);
      }

      expect(hasSchemaObject(database, "table", retirement.table)).toBe(shouldExist);
      for (const index of retirement.indexes) {
        expect(hasSchemaObject(database, "index", index)).toBe(shouldExist);
      }
    }
  } finally {
    for (const database of Object.values(databases)) {
      database.database.close();
    }
  }
});
