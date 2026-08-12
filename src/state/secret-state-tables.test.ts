import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AGENT_SECRET_TABLE_NAMES, STATE_SECRET_TABLE_NAMES } from "./secret-state-tables.js";

const REVIEWED_SAFE_TABLES = {
  exec_approvals_config:
    "has_socket_token is a presence bit; snapshot sanitization removes the token value",
  operator_approvals: "requested_by_device_token_auth is boolean provenance, not token material",
} as const;

const EMBEDDED_CREDENTIAL_TABLES = {
  // payload_json stores the pairing setup payload, including its live bootstrapToken.
  device_pairing_join_codes: "payload_json contains a pairing bootstrapToken",
} as const;

const CREDENTIAL_COLUMN_SEGMENT =
  /(?:^|_)(?:token|secret|private_key|api_key|password|credential)(?:_|$)/u;

function tablesWithCredentialColumns(sql: string): Map<string, string[]> {
  const matches = new Map<string, string[]>();
  const tablePattern =
    /CREATE TABLE IF NOT EXISTS ([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*?)\)\s*STRICT;/gu;
  for (const tableMatch of sql.matchAll(tablePattern)) {
    const table = tableMatch[1];
    const body = tableMatch[2];
    if (!table || !body) {
      continue;
    }
    const columns = body
      .split("\n")
      .map((line) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+/u.exec(line)?.[1])
      .filter(
        (column): column is string =>
          typeof column === "string" &&
          CREDENTIAL_COLUMN_SEGMENT.test(column) &&
          !column.endsWith("_hash"),
      );
    if (columns.length > 0) {
      matches.set(table, columns);
    }
  }
  return matches;
}

describe("secret state table policy", () => {
  it("classifies every schema table with credential-suggestive columns", async () => {
    const schemas = [
      {
        name: "openclaw-state-schema.sql",
        sql: await fs.readFile(new URL("./openclaw-state-schema.sql", import.meta.url), "utf8"),
        secretTables: new Set<string>(STATE_SECRET_TABLE_NAMES),
      },
      {
        name: "openclaw-agent-schema.sql",
        sql: await fs.readFile(new URL("./openclaw-agent-schema.sql", import.meta.url), "utf8"),
        secretTables: new Set<string>(AGENT_SECRET_TABLE_NAMES),
      },
    ];
    const reviewedSafeTables = new Set(Object.keys(REVIEWED_SAFE_TABLES));
    const classifiedSafeTables = new Set<string>();
    const missing: string[] = [];

    for (const schema of schemas) {
      for (const [table, columns] of tablesWithCredentialColumns(schema.sql)) {
        if (schema.secretTables.has(table)) {
          continue;
        }
        if (reviewedSafeTables.has(table)) {
          classifiedSafeTables.add(table);
          continue;
        }
        missing.push(`${schema.name}: ${table} (${columns.join(", ")})`);
      }
    }

    expect(missing, "credential-bearing tables must be redacted or reviewed safe").toEqual([]);
    expect([...classifiedSafeTables].toSorted()).toEqual([...reviewedSafeTables].toSorted());
  });

  it("classifies opaque payload tables that embed credentials", () => {
    const secretTables = new Set<string>(STATE_SECRET_TABLE_NAMES);
    for (const [table, reason] of Object.entries(EMBEDDED_CREDENTIAL_TABLES)) {
      expect(secretTables.has(table), reason).toBe(true);
    }
  });
});
