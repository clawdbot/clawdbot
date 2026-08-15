import { describe, expect, it } from "vitest";
import { serializeSessionCleanupResult } from "./cleanup-service.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

describe("serializeSessionCleanupResult", () => {
  it("reports the physical SQLite store path", () => {
    const storePath = "/tmp/openclaw-cleanup-sessions.json";
    const result = serializeSessionCleanupResult({
      mode: "enforce",
      dryRun: false,
      summaries: [
        {
          agentId: "main",
          storePath,
          mode: "enforce",
          dryRun: false,
          beforeCount: 1,
          afterCount: 1,
          missing: 0,
          dmScopeRetired: 0,
          modelRunPruned: 0,
          pruned: 0,
          capped: 0,
          unreferencedArtifacts: undefined,
          diskBudget: undefined,
          wouldMutate: false,
          applied: true,
          appliedCount: 0,
        },
      ],
    });

    expect(result).toMatchObject({
      storePath: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
    });
  });
});
