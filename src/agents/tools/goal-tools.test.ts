// Goal tool tests cover goal accounting projection and correct session-store
// routing for global and scoped sessions.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  loadSessionEntry,
  upsertSessionEntry as upsertAccessorSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createCreateGoalTool, createGetGoalTool } from "./goal-tools.js";

async function createStoreConfig(): Promise<{ config: OpenClawConfig; template: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-goal-tools-"));
  const template = path.join(dir, "{agentId}", "sessions.json");
  return {
    config: { session: { store: template } } as OpenClawConfig,
    template,
  };
}

// Goal tools read/write through the SQLite-backed accessor, so test fixtures
// must seed and assert through the same boundary.
function getSessionEntry(params: {
  storePath: string;
  sessionKey: string;
}): SessionEntry | undefined {
  return loadSessionEntry(params);
}

async function upsertSessionEntry(params: {
  storePath: string;
  sessionKey: string;
  entry: SessionEntry;
}): Promise<void> {
  await upsertAccessorSessionEntry(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    params.entry,
  );
}

describe("goal tools", () => {
  it("keeps get_goal read-only when accounting changes are projected", async () => {
    // Budget-limited status can be derived for display without mutating the
    // stored active goal record.
    const { config, template } = await createStoreConfig();
    const storePath = resolveStorePath(template, { agentId: "research" });
    await upsertSessionEntry({
      storePath,
      sessionKey: "global",
      entry: {
        sessionId: "sess-global",
        updatedAt: 1,
        totalTokens: 125,
        totalTokensFresh: true,
        goal: {
          schemaVersion: 1,
          id: "goal-1",
          objective: "ship",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 100,
          tokenStartFresh: true,
          tokensUsed: 0,
          tokenBudget: 20,
          continuationTurns: 0,
        },
      },
    });
    const tool = createGetGoalTool({
      agentSessionKey: "global",
      runSessionKey: "global",
      sessionAgentId: "research",
      config,
    });

    const result = await tool.execute("call-1", {});

    expect((result.details as { goal?: { status?: string } }).goal?.status).toBe("budget_limited");
    expect(getSessionEntry({ storePath, sessionKey: "global" })?.goal?.status).toBe("active");
  });

  it("uses the resolved session agent for global session stores", async () => {
    const { config, template } = await createStoreConfig();
    const tool = createCreateGoalTool({
      agentSessionKey: "global",
      runSessionKey: "global",
      sessionAgentId: "research",
      config,
    });

    const researchStorePath = resolveStorePath(template, { agentId: "research" });
    await upsertSessionEntry({
      storePath: researchStorePath,
      sessionKey: "global",
      entry: { sessionId: "sess-global", updatedAt: 1 },
    });
    await tool.execute("call-1", { objective: "ship global work" });

    const mainStorePath = resolveStorePath(template, { agentId: "main" });
    expect(
      getSessionEntry({ storePath: researchStorePath, sessionKey: "global" })?.goal?.objective,
    ).toBe("ship global work");
    expect(
      getSessionEntry({ storePath: mainStorePath, sessionKey: "global" })?.goal,
    ).toBeUndefined();
  });

  it.each(["42.9", "1abc", 0])(
    "rejects invalid token budgets before creating a goal: %s",
    async (tokenBudget) => {
      const { config, template } = await createStoreConfig();
      const tool = createCreateGoalTool({
        agentSessionKey: "global",
        runSessionKey: "global",
        sessionAgentId: "research",
        config,
      });

      const storePath = resolveStorePath(template, { agentId: "research" });
      await upsertSessionEntry({
        storePath,
        sessionKey: "global",
        entry: { sessionId: "sess-global", updatedAt: 1 },
      });
      await expect(
        tool.execute("call-invalid-budget", {
          objective: "ship global work",
          token_budget: tokenBudget,
        }),
      ).rejects.toThrow("token_budget must be a positive integer");

      expect(getSessionEntry({ storePath, sessionKey: "global" })?.goal).toBeUndefined();
    },
  );

  it("prefers scoped run session keys over the fallback session agent", async () => {
    const { config, template } = await createStoreConfig();
    const tool = createCreateGoalTool({
      agentSessionKey: "global",
      runSessionKey: "agent:ops:main",
      sessionAgentId: "research",
      config,
    });

    const opsStorePath = resolveStorePath(template, { agentId: "ops" });
    await upsertSessionEntry({
      storePath: opsStorePath,
      sessionKey: "agent:ops:main",
      entry: { sessionId: "sess-ops", updatedAt: 1 },
    });
    await tool.execute("call-1", { objective: "ship ops work" });

    const researchStorePath = resolveStorePath(template, { agentId: "research" });
    expect(
      getSessionEntry({ storePath: opsStorePath, sessionKey: "agent:ops:main" })?.goal?.objective,
    ).toBe("ship ops work");
    expect(
      getSessionEntry({ storePath: researchStorePath, sessionKey: "agent:ops:main" })?.goal,
    ).toBeUndefined();
  });
});
