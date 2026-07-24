import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { unregisterOpenClawAgentDatabase } from "../../state/openclaw-agent-db-registry.js";
import { replaceSessionEntry } from "./session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

describe("explicit SQLite session target ownership", () => {
  it("honors durable ownership after the registry row is removed", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const databasePath = path.join(home, "shared.sqlite");
      await replaceSessionEntry(
        {
          agentId: "ops",
          defaultAgentId: "main",
          env,
          storePath: databasePath,
          sessionKey: "agent:ops:main",
        },
        { sessionId: "ops-session", updatedAt: 1 },
      );
      unregisterOpenClawAgentDatabase({ agentId: "ops", env, path: databasePath });

      expect(resolveSqliteTargetFromSessionStorePath(databasePath, { env })).toMatchObject({
        agentId: "ops",
        ownerSource: "database-path",
        path: databasePath,
      });
    });
  });
});
