// Goal tool tests cover goal accounting projection and correct session-store
// routing for global and scoped sessions.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { updateSessionGoalStatus } from "../../config/sessions/goals.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore as upsertAccessorSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry, SessionGoal } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createCreateGoalTool, createGetGoalTool, createUpdateGoalTool } from "./goal-tools.js";

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
    const storePath = resolveSessionStorePathCore(template, { agentId: "research" });
    await upsertSessionEntry({
      storePath,
      sessionKey: "global",
      entry: {
        sessionId: "sess-global",
        updatedAt: 1,
        totalTokens: 125,
        totalTokensFresh: true,
        totalTokensVersion: 1,
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

    const researchStorePath = resolveSessionStorePathCore(template, { agentId: "research" });
    await upsertSessionEntry({
      storePath: researchStorePath,
      sessionKey: "global",
      entry: { sessionId: "sess-global", updatedAt: 1 },
    });
    await tool.execute("call-1", { objective: "ship global work" });

    const mainStorePath = resolveSessionStorePathCore(template, { agentId: "main" });
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

      const storePath = resolveSessionStorePathCore(template, { agentId: "research" });
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

    const opsStorePath = resolveSessionStorePathCore(template, { agentId: "ops" });
    await upsertSessionEntry({
      storePath: opsStorePath,
      sessionKey: "agent:ops:main",
      entry: { sessionId: "sess-ops", updatedAt: 1 },
    });
    await tool.execute("call-1", { objective: "ship ops work" });

    const researchStorePath = resolveSessionStorePathCore(template, { agentId: "research" });
    expect(
      getSessionEntry({ storePath: opsStorePath, sessionKey: "agent:ops:main" })?.goal?.objective,
    ).toBe("ship ops work");
    expect(
      getSessionEntry({ storePath: researchStorePath, sessionKey: "agent:ops:main" })?.goal,
    ).toBeUndefined();
  });

  it("tells the model to send the requested final reply after completing a goal", async () => {
    const { config, template } = await createStoreConfig();
    const storePath = resolveSessionStorePathCore(template, { agentId: "research" });
    const options = {
      agentSessionKey: "global",
      runSessionKey: "global",
      sessionAgentId: "research",
      config,
    };
    await upsertSessionEntry({
      storePath,
      sessionKey: "global",
      entry: { sessionId: "sess-global", updatedAt: 1 },
    });
    await createCreateGoalTool(options).execute("call-create", {
      objective: "Write the artifact and reply GOAL-DONE",
    });

    const tool = createUpdateGoalTool(options);
    const result = await tool.execute("call-complete", { status: "complete" });

    expect(tool.description).toContain("does not reply to the user");
    expect(result.details).toMatchObject({
      status: "updated",
      goal: { status: "complete" },
      nextAction: expect.stringContaining("provide the requested visible final response"),
    });
    expect(result.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("provide the requested visible final response"),
      }),
    ]);
    expect(getSessionEntry({ storePath, sessionKey: "global" })?.goal?.status).toBe("complete");
  });

  it("lets the model pause and resume a goal it owns", async () => {
    const { config, template } = await createStoreConfig();
    const storePath = resolveSessionStorePathCore(template, { agentId: "research" });
    const options = {
      agentSessionKey: "global",
      runSessionKey: "global",
      sessionAgentId: "research",
      config,
    };
    await upsertSessionEntry({
      storePath,
      sessionKey: "global",
      entry: { sessionId: "sess-global", updatedAt: 1 },
    });
    await createCreateGoalTool(options).execute("call-create", {
      objective: "Land the report once the upstream API ships",
    });

    const tool = createUpdateGoalTool(options);

    const paused = await tool.execute("call-pause", {
      status: "paused",
      note: "waiting on upstream API release",
    });
    const pausedGoal = getSessionEntry({ storePath, sessionKey: "global" })?.goal;
    expect(paused.details).toMatchObject({ status: "updated", goal: { status: "paused" } });
    expect(pausedGoal?.status).toBe("paused");
    expect(pausedGoal?.pausedAt).toBeTypeOf("number");
    expect(pausedGoal?.lastStatusNote).toBe("waiting on upstream API release");

    const resumed = await tool.execute("call-resume", { status: "active" });
    const resumedGoal = getSessionEntry({ storePath, sessionKey: "global" })?.goal;
    expect(resumed.details).toMatchObject({ status: "updated", goal: { status: "active" } });
    expect(resumedGoal?.status).toBe("active");
  });

  // The model-facing active transition must be narrowed at the goal owner: an
  // agent can only resume a goal it paused, not clear a user/system budget limit
  // or retract a blocked state. Humans keep the full resume path.
  describe("update_goal active transition is actor-scoped", () => {
    async function seedGoal(
      storePath: string,
      status: SessionGoal["status"],
      over: Partial<SessionGoal> = {},
    ): Promise<void> {
      await upsertSessionEntry({
        storePath,
        sessionKey: "global",
        entry: {
          sessionId: "sess-global",
          updatedAt: 1,
          goal: {
            schemaVersion: 1,
            id: "goal-1",
            objective: "ship",
            status,
            createdAt: 1,
            updatedAt: 1,
            tokenStart: 0,
            tokensUsed: 0,
            continuationTurns: 0,
            ...over,
          },
        },
      });
    }

    const baseScope = {
      sessionKey: "global",
      storePath: "",
      agentId: "research",
    } as const;

    it("rejects an agent resuming a blocked goal", async () => {
      const { template } = await createStoreConfig();
      const storePath = resolveSessionStorePathCore(template, { agentId: "research" });
      await seedGoal(storePath, "blocked", { blockedAt: 1 });

      await expect(
        updateSessionGoalStatus({
          ...baseScope,
          storePath,
          actor: { type: "agent", id: "global" },
          status: "active",
        }),
      ).rejects.toThrow(/agents can only resume a paused goal/);
      expect(getSessionEntry({ storePath, sessionKey: "global" })?.goal?.status).toBe("blocked");
    });

    it("rejects an agent resuming a budget-limited goal", async () => {
      const { template } = await createStoreConfig();
      const storePath = resolveSessionStorePathCore(template, { agentId: "research" });
      await seedGoal(storePath, "budget_limited", {
        tokenBudget: 20,
        tokensUsed: 25,
        budgetLimitedAt: 1,
      });

      await expect(
        updateSessionGoalStatus({
          ...baseScope,
          storePath,
          actor: { type: "agent", id: "global" },
          status: "active",
        }),
      ).rejects.toThrow(/agents can only resume a paused goal/);
      const goal = getSessionEntry({ storePath, sessionKey: "global" })?.goal;
      expect(goal?.status).toBe("budget_limited");
      expect(goal?.tokensUsed).toBe(25);
    });

    it("allows a human to resume a budget-limited goal (resets the window)", async () => {
      const { template } = await createStoreConfig();
      const storePath = resolveSessionStorePathCore(template, { agentId: "research" });
      await seedGoal(storePath, "budget_limited", {
        tokenBudget: 20,
        tokensUsed: 25,
        budgetLimitedAt: 1,
      });

      const goal = await updateSessionGoalStatus({
        ...baseScope,
        storePath,
        actor: { type: "human" },
        status: "active",
      });
      expect(goal.status).toBe("active");
      expect(goal.tokensUsed).toBe(0);
      expect(goal.budgetLimitedAt).toBeUndefined();
    });

    it("rejects an agent pausing a blocked goal (no pause-then-resume bypass)", async () => {
      const { template } = await createStoreConfig();
      const storePath = resolveSessionStorePathCore(template, { agentId: "research" });
      await seedGoal(storePath, "blocked", { blockedAt: 1 });

      await expect(
        updateSessionGoalStatus({
          ...baseScope,
          storePath,
          actor: { type: "agent", id: "global" },
          status: "paused",
        }),
      ).rejects.toThrow(/agents can only pause an active goal/);
      expect(getSessionEntry({ storePath, sessionKey: "global" })?.goal?.status).toBe("blocked");
    });

    it("rejects an agent pausing a budget-limited goal (no pause-then-resume bypass)", async () => {
      const { template } = await createStoreConfig();
      const storePath = resolveSessionStorePathCore(template, { agentId: "research" });
      await seedGoal(storePath, "budget_limited", {
        tokenBudget: 20,
        tokensUsed: 25,
        budgetLimitedAt: 1,
      });

      await expect(
        updateSessionGoalStatus({
          ...baseScope,
          storePath,
          actor: { type: "agent", id: "global" },
          status: "paused",
        }),
      ).rejects.toThrow(/agents can only pause an active goal/);
      const goal = getSessionEntry({ storePath, sessionKey: "global" })?.goal;
      expect(goal?.status).toBe("budget_limited");
      expect(goal?.tokensUsed).toBe(25);
    });

    it("allows an agent to pause an active goal", async () => {
      const { template } = await createStoreConfig();
      const storePath = resolveSessionStorePathCore(template, { agentId: "research" });
      await seedGoal(storePath, "active");

      const goal = await updateSessionGoalStatus({
        ...baseScope,
        storePath,
        actor: { type: "agent", id: "global" },
        status: "paused",
      });
      expect(goal.status).toBe("paused");
      expect(goal.pausedAt).toBeTypeOf("number");
    });

    it("allows a human to pause a blocked goal (human keeps full pause path)", async () => {
      const { template } = await createStoreConfig();
      const storePath = resolveSessionStorePathCore(template, { agentId: "research" });
      await seedGoal(storePath, "blocked", { blockedAt: 1 });

      const goal = await updateSessionGoalStatus({
        ...baseScope,
        storePath,
        actor: { type: "human" },
        status: "paused",
      });
      expect(goal.status).toBe("paused");
    });

    it("rejects an agent resuming a paused goal with an exhausted budget", async () => {
      const { template } = await createStoreConfig();
      const storePath = resolveSessionStorePathCore(template, { agentId: "research" });
      await seedGoal(storePath, "paused", {
        tokenBudget: 20,
        tokensUsed: 25,
        pausedAt: 1,
      });

      await expect(
        updateSessionGoalStatus({
          ...baseScope,
          storePath,
          actor: { type: "agent", id: "global" },
          status: "active",
        }),
      ).rejects.toThrow(/agents cannot resume a goal whose token budget is exhausted/);
      const goal = getSessionEntry({ storePath, sessionKey: "global" })?.goal;
      expect(goal?.status).toBe("paused");
      expect(goal?.tokensUsed).toBe(25);
    });

    it("allows an agent to resume a paused goal under its budget", async () => {
      const { template } = await createStoreConfig();
      const storePath = resolveSessionStorePathCore(template, { agentId: "research" });
      await seedGoal(storePath, "paused", {
        tokenBudget: 20,
        tokensUsed: 5,
        pausedAt: 1,
      });

      const goal = await updateSessionGoalStatus({
        ...baseScope,
        storePath,
        actor: { type: "agent", id: "global" },
        status: "active",
      });
      expect(goal.status).toBe("active");
      expect(goal.tokensUsed).toBe(5);
    });

    it("allows a human to resume a paused goal with an exhausted budget (resets the window)", async () => {
      const { template } = await createStoreConfig();
      const storePath = resolveSessionStorePathCore(template, { agentId: "research" });
      await seedGoal(storePath, "paused", {
        tokenBudget: 20,
        tokensUsed: 25,
        pausedAt: 1,
      });

      const goal = await updateSessionGoalStatus({
        ...baseScope,
        storePath,
        actor: { type: "human" },
        status: "active",
      });
      expect(goal.status).toBe("active");
      expect(goal.tokensUsed).toBe(0);
    });
  });
});
