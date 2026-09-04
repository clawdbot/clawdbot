import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import packageJson from "../../package.json" with { type: "json" };
import { appendTranscriptEventsInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";

export async function probeTranscriptHealthMemory(
  stateDir: string,
  scenario: "headers" | "labels",
) {
  const cacheDir = path.join(process.cwd(), "node_modules/.cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const bundleDir = fs.mkdtempSync(path.join(cacheDir, "transcript-health-memory-"));
  const childPath = path.join(bundleDir, "child.mjs");
  try {
    for (const schema of ["openclaw-agent-schema.sql", "openclaw-state-schema.sql"]) {
      fs.copyFileSync(path.join(process.cwd(), "src/state", schema), path.join(bundleDir, schema));
    }
    await build({
      bundle: true,
      entryPoints: [
        fileURLToPath(
          new URL(
            "./doctor-session-transcript-health.memory-fixture.test-support.ts",
            import.meta.url,
          ),
        ),
      ],
      format: "esm",
      outfile: childPath,
      external: Object.entries(packageJson.dependencies)
        .filter(([, version]) => !version.startsWith("workspace:"))
        .map(([name]) => name),
      platform: "node",
      target: "node22",
    });
    const { sqlitePath, expectedDigest } = seedTranscriptHealthHistory();
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--max-old-space-size=256", childPath, stateDir, scenario, sqlitePath, expectedDigest],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      },
    );
    return JSON.parse(stdout) as { scenario: string; eventCount: number };
  } finally {
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
}

function seedTranscriptHealthHistory() {
  const sessionId = "healthy-history";
  const eventCount = 4096;
  const timestamp = "2026-07-15T21:23:03.698Z";
  const hash = createHash("sha256");
  let sqlitePath = "";

  // Seed the canonical storage schema without making unrelated projection work part of this probe.
  runOpenClawAgentWriteTransaction(
    (database) => {
      sqlitePath = database.path;

      appendTranscriptEventsInTransaction(
        database,
        {
          agentId: "main",
          sessionId,
          sessionKey: "agent:main:healthy-history",
        },
        [{ type: "session", id: sessionId, version: 3, timestamp, cwd: "/fixture" }],
      );
      const insert = database.db.prepare(
        "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
      );
      for (let index = 1; index <= eventCount; index++) {
        insert.run(
          sessionId,
          index,
          JSON.stringify({
            type: "message",
            id: `event-${index}`,
            parentId: index === 1 ? null : `event-${index - 1}`,
            timestamp,
            message: {
              role: index % 2 ? "user" : "assistant",
              content: `${index}:${"x".repeat(80 * 1024)}`,
            },
          }),
          index,
        );
      }

      // A stored header is not required to be at seq=0.
      database.db.exec(
        "PRAGMA defer_foreign_keys = ON; UPDATE transcript_event_identities SET seq = -7 WHERE seq = 0; UPDATE transcript_events SET seq = -7 WHERE seq = 0;",
      );
      for (const row of database.db
        .prepare(
          "SELECT seq, created_at, event_json FROM transcript_events ORDER BY session_id, seq",
        )
        .iterate()) {
        hash.update(JSON.stringify(row));
      }
    },
    { agentId: "main", env: process.env },
  );
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  return { sqlitePath, expectedDigest: hash.digest("hex") };
}
