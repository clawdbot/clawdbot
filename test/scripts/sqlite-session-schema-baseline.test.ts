// Verifies the SQLite sessions/transcripts schema baseline stays targeted.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeSqliteSessionSchemaBaselineHashFileContent,
  renderSqliteSessionSchemaBaseline,
  writeSqliteSessionSchemaBaselineArtifacts,
} from "../../scripts/lib/sqlite-session-schema-baseline.ts";

describe("SQLite sessions/transcripts schema baseline", () => {
  it("includes session and transcript DDL while excluding unrelated agent tables", async () => {
    const sourceSql = await readFile("src/state/openclaw-agent-schema.sql", "utf8");

    const rendered = renderSqliteSessionSchemaBaseline(sourceSql);

    expect(rendered.sql).toContain("CREATE TABLE IF NOT EXISTS sessions");
    expect(rendered.sql).toContain("CREATE TABLE IF NOT EXISTS transcript_events");
    expect(rendered.sql).toContain("CREATE TABLE IF NOT EXISTS transcript_event_identities");
    expect(rendered.sql).not.toContain("idx_agent_transcript_events_session");
    expect(rendered.sql).not.toContain("CREATE TABLE IF NOT EXISTS cache_entries");
    expect(rendered.sql).not.toContain("CREATE TABLE IF NOT EXISTS auth_profile_store");
    expect(rendered.sql).not.toContain("CREATE TABLE IF NOT EXISTS memory_index_sources");
  });

  it("automatically includes new indexes declared on target tables", () => {
    const rendered = renderSqliteSessionSchemaBaseline(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT NOT NULL PRIMARY KEY
      );

      CREATE INDEX IF NOT EXISTS idx_agent_sessions_custom
        ON sessions(session_id);

      CREATE INDEX IF NOT EXISTS idx_agent_cache_custom
        ON cache_entries(scope);
    `);

    expect(rendered.sql).toContain("CREATE INDEX IF NOT EXISTS idx_agent_sessions_custom");
    expect(rendered.sql).not.toContain("idx_agent_cache_custom");
  });

  it("checks generated SQL and hash artifacts for drift", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "openclaw-sqlite-schema-baseline-"));
    const schemaPath = path.join(tmp, "schema.sql");
    const sqlPath = path.join(tmp, "baseline.sql");
    const hashPath = path.join(tmp, "baseline.sha256");
    await writeFile(
      schemaPath,
      `
        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT NOT NULL PRIMARY KEY
        );
      `,
    );

    const writeResult = await writeSqliteSessionSchemaBaselineArtifacts({
      repoRoot: tmp,
      check: false,
      schemaInputPath: "schema.sql",
      sqlOutputPath: "baseline.sql",
      hashOutputPath: "baseline.sha256",
    });
    const cleanCheck = await writeSqliteSessionSchemaBaselineArtifacts({
      repoRoot: tmp,
      check: true,
      schemaInputPath: "schema.sql",
      sqlOutputPath: "baseline.sql",
      hashOutputPath: "baseline.sha256",
    });
    const generatedSql = await readFile(sqlPath, "utf8");
    await rm(sqlPath);
    const cleanCheckWithoutLocalSql = await writeSqliteSessionSchemaBaselineArtifacts({
      repoRoot: tmp,
      check: true,
      schemaInputPath: "schema.sql",
      sqlOutputPath: "baseline.sql",
      hashOutputPath: "baseline.sha256",
    });
    await writeFile(hashPath, "stale\n");
    const staleCheck = await writeSqliteSessionSchemaBaselineArtifacts({
      repoRoot: tmp,
      check: true,
      schemaInputPath: "schema.sql",
      sqlOutputPath: "baseline.sql",
      hashOutputPath: "baseline.sha256",
    });

    expect(writeResult).toMatchObject({ changed: true, wrote: true });
    expect(cleanCheck.changed).toBe(false);
    expect(cleanCheckWithoutLocalSql.changed).toBe(false);
    expect(staleCheck.changed).toBe(true);
    expect(await readFile(hashPath, "utf8")).not.toBe(
      computeSqliteSessionSchemaBaselineHashFileContent({
        sql: generatedSql,
      }),
    );
  });
});
