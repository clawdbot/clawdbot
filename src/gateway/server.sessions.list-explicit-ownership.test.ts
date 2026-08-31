import path from "node:path";
import { expect, test } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

setupGatewaySessionsHandlerTestHarness();

test("sessions.list excludes ownerless sentinels for explicit multi-agent federation", async () => {
  const rootStateDir = process.env.OPENCLAW_STATE_DIR;
  if (!rootStateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required for gateway session tests");
  }
  const stateDir = path.join(rootStateDir, "explicit-ownership-list-regression");
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    const agentsDir = path.join(stateDir, "agents");
    const storeTemplate = path.join(agentsDir, "{agentId}", "sessions", "sessions.json");
    testState.sessionConfig = { store: storeTemplate };
    testState.agentsConfig = {
      ownership: "explicit",
      list: [{ id: "ops" }, { id: "research" }],
    };
    testState.agentConfig = { sessionStore: { agentId: "ops" } };
    await writeSessionStore({
      storePath: storeTemplate.replace("{agentId}", "ops"),
      agentId: "ops",
      entries: {
        main: { sessionId: "sess-ops", updatedAt: 20 },
        global: { sessionId: "sess-global", updatedAt: 19 },
        unknown: { sessionId: "sess-unknown", updatedAt: 18 },
      },
    });
    await writeSessionStore({
      storePath: storeTemplate.replace("{agentId}", "research"),
      agentId: "research",
      entries: { main: { sessionId: "sess-research", updatedAt: 21 } },
    });

    await expect(
      directSessionReq("sessions.list", {
        includeGlobal: true,
        includeUnknown: true,
        configuredAgentsOnly: true,
      }),
    ).rejects.toThrow(
      'Multiple agents are configured, but session key "global" has no explicit owner.',
    );

    const configuredOnly = await directSessionReq<{ sessions: Array<{ key: string }> }>(
      "sessions.list",
      { includeGlobal: false, includeUnknown: false, configuredAgentsOnly: true },
    );
    expect(configuredOnly.ok).toBe(true);
    expect(configuredOnly.payload?.sessions.map((session) => session.key)).toEqual([
      "agent:research:main",
      "agent:ops:main",
    ]);
  });
});
