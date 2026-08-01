import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { listSessionEntriesReadOnly } from "./session-accessor.js";
import { querySqliteSessionEntriesReadOnly } from "./session-accessor.sqlite-entry.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

describe("SQLite session list pushdown", () => {
  afterEach(() => closeOpenClawAgentDatabasesForTest());

  test("parses only the bounded active window", async () => {
    await withStateDirEnv("openclaw-session-list-perf-", async ({ stateDir }) => {
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
      const database = openOpenClawAgentDatabase({ agentId: "main", path: target.path });
      const insert = database.db.prepare(`
        INSERT INTO session_nodes (
          session_key, current_session_id, entry_json, updated_at,
          archived_at, last_interaction_at, display_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const nodeCount = 12_000;
      database.db.exec("BEGIN");
      try {
        for (let index = 0; index < nodeCount; index += 1) {
          const sessionId = `session-${index}`;
          const updatedAt = nodeCount - index;
          insert.run(
            `agent:main:session-${index}`,
            sessionId,
            JSON.stringify({
              sessionId,
              updatedAt,
              payload: "x".repeat(2_048),
            }),
            updatedAt,
            index % 4 === 0 ? updatedAt : null,
            updatedAt,
            `Session ${index}`,
          );
        }
        database.db.prepare("UPDATE session_nodes SET entry_valid = 1").run();
        database.db.exec("COMMIT");
      } catch (error) {
        database.db.exec("ROLLBACK");
        throw error;
      }

      const measure = (run: () => unknown): number => {
        const startedAt = performance.now();
        run();
        return performance.now() - startedAt;
      };
      const baseline = () =>
        listSessionEntriesReadOnly({
          agentId: "main",
          clone: false,
          projection: "list",
          readConsistency: "latest",
          storePath,
        })
          .filter(({ entry }) => entry.archivedAt === undefined)
          .toSorted((left, right) => right.entry.updatedAt - left.entry.updatedAt)
          .slice(0, 100);
      const pushedDown = () =>
        querySqliteSessionEntriesReadOnly({
          agentId: "main",
          clone: false,
          projection: "list",
          query: {
            archived: false,
            includeGlobal: true,
            includeUnknown: true,
            limit: 100,
            sortBy: "updatedAt",
          },
          storePath,
        });
      baseline();
      pushedDown();
      const median = (samples: number[]) => samples.toSorted((a, b) => a - b)[2] ?? 0;
      const baselineMs = median(Array.from({ length: 5 }, () => measure(baseline)));
      const pushedDownMs = median(Array.from({ length: 5 }, () => measure(pushedDown)));
      console.info(
        `[session-list-perf] nodes=${nodeCount} baseline_ms=${baselineMs.toFixed(2)} pushed_down_ms=${pushedDownMs.toFixed(2)} speedup=${(baselineMs / pushedDownMs).toFixed(1)}x`,
      );
      expect(baselineMs / pushedDownMs).toBeGreaterThanOrEqual(3.5);
    });
  });
});
