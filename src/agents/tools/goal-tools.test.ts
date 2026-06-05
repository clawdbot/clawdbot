// Goal tool tests cover goal accounting projection and correct session-store
// routing for global and scoped sessions.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { loadSessionStore, upsertSessionEntry } from "../../config/sessions/store.js";
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
    expect(loadSessionStore(storePath, { skipCache: true }).global?.goal?.status).toBe("active");
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
    expect(loadSessionStore(researchStorePath, { skipCache: true }).global?.goal?.objective).toBe(
      "ship global work",
    );
    expect(loadSessionStore(mainStorePath, { skipCache: true }).global?.goal).toBeUndefined();
  });

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
      loadSessionStore(opsStorePath, { skipCache: true })["agent:ops:main"]?.goal?.objective,
    ).toBe("ship ops work");
    expect(
      loadSessionStore(researchStorePath, { skipCache: true })["agent:ops:main"]?.goal,
    ).toBeUndefined();
  });
});
