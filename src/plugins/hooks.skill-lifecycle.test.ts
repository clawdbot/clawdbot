import { describe, expect, it, vi } from "vitest";
import type {
  PluginHookSkillChangedEvent,
  PluginHookSkillContext,
  PluginHookSkillProposalEvaluateEvent,
} from "./hook-types.js";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

const ctx: PluginHookSkillContext = {
  workspaceDir: "/tmp/openclaw-workspace",
  agentId: "main",
};

const evaluationEvent: PluginHookSkillProposalEvaluateEvent = {
  proposal: {
    id: "proposal-1",
    kind: "update",
    revision: "v2",
    revisionSha256: "sha256:revision",
    targetCurrentSha256: "sha256:current",
  },
  skill: {
    name: "Demo Skill",
    skillKey: "demo-skill",
    description: "Demonstrates proposal evaluation.",
    source: "openclaw-workspace",
  },
  candidate: {
    skillMd: {
      path: "SKILL.md",
      content: "---\nname: demo-skill\n---\n",
      encoding: "utf8",
      sha256: "sha256:candidate",
      sizeBytes: 30,
    },
    files: [],
    treeSha256: "sha256:candidate-tree",
  },
  baseline: {
    skillMd: {
      path: "SKILL.md",
      content: "---\nname: demo-skill\n---\nold\n",
      encoding: "utf8",
      sha256: "sha256:baseline",
      sizeBytes: 34,
    },
    files: [],
    treeSha256: "sha256:baseline-tree",
  },
  reason: "revised",
};

describe("skill lifecycle hooks", () => {
  it("collects every proposal evaluator with stable priority and plugin attribution", async () => {
    const high = vi.fn(() => ({
      summary: "candidate regressed",
      metrics: { score: 0.4 },
      evaluatorVersion: "rules-3",
      decision: "block" as const,
      decisionReason: "score below baseline",
    }));
    const low = vi.fn(() => undefined);
    const registry = createMockPluginRegistry([
      {
        hookName: "skill_proposal_evaluate",
        pluginId: "low",
        priority: 10,
        handler: low,
      },
      {
        hookName: "skill_proposal_evaluate",
        pluginId: "high",
        priority: 100,
        registrationId: "regression-score",
        handler: high,
      },
    ]);
    const highPlugin = registry.plugins.find((plugin) => plugin.id === "high")!;
    highPlugin.packageVersion = "2.1.0";
    highPlugin.version = "runtime-override";

    const outcomes = await createHookRunner(registry).runSkillProposalEvaluate(
      evaluationEvent,
      ctx,
    );

    expect(outcomes).toEqual([
      {
        evaluatorId: "regression-score",
        pluginId: "high",
        pluginVersion: "2.1.0",
        status: "completed",
        result: {
          summary: "candidate regressed",
          metrics: { score: 0.4 },
          evaluatorVersion: "rules-3",
          decision: "block",
          decisionReason: "score below baseline",
        },
      },
      {
        evaluatorId: "low",
        pluginId: "low",
        status: "skipped",
      },
    ]);
    expect(high).toHaveBeenCalledTimes(1);
    expect(low).toHaveBeenCalledTimes(1);
  });

  it("runs evaluators concurrently while retaining priority order", async () => {
    let releaseHigh: (() => void) | undefined;
    let releaseLow: (() => void) | undefined;
    const highGate = new Promise<void>((resolve) => {
      releaseHigh = resolve;
    });
    const lowGate = new Promise<void>((resolve) => {
      releaseLow = resolve;
    });
    const high = vi.fn(async () => {
      await highGate;
      return { summary: "high" };
    });
    const low = vi.fn(async () => {
      await lowGate;
      return { summary: "low" };
    });
    const registry = createMockPluginRegistry([
      {
        hookName: "skill_proposal_evaluate",
        pluginId: "low",
        priority: 10,
        handler: low,
      },
      {
        hookName: "skill_proposal_evaluate",
        pluginId: "high",
        priority: 100,
        handler: high,
      },
    ]);

    const evaluation = createHookRunner(registry).runSkillProposalEvaluate(evaluationEvent, ctx);
    await vi.waitFor(() => {
      expect(high).toHaveBeenCalledTimes(1);
      expect(low).toHaveBeenCalledTimes(1);
    });
    releaseLow?.();
    releaseHigh?.();

    await expect(evaluation).resolves.toEqual([
      {
        evaluatorId: "high",
        pluginId: "high",
        status: "completed",
        result: { summary: "high" },
      },
      {
        evaluatorId: "low",
        pluginId: "low",
        status: "completed",
        result: { summary: "low" },
      },
    ]);
  });

  it("passes a frozen candidate snapshot to every evaluator", async () => {
    const first = vi.fn((event: PluginHookSkillProposalEvaluateEvent) => {
      expect(event).not.toBe(evaluationEvent);
      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.isFrozen(event.candidate)).toBe(true);
      expect(Object.isFrozen(event.candidate.skillMd)).toBe(true);
      expect(() => {
        event.candidate.skillMd.content = "mutated";
      }).toThrow();
      return { summary: "first" };
    });
    const second = vi.fn((event: PluginHookSkillProposalEvaluateEvent) => {
      expect(event.candidate.skillMd.content).toBe(evaluationEvent.candidate.skillMd.content);
      return { summary: "second" };
    });
    const registry = createMockPluginRegistry([
      { hookName: "skill_proposal_evaluate", pluginId: "first", handler: first },
      { hookName: "skill_proposal_evaluate", pluginId: "second", handler: second },
    ]);

    await expect(
      createHookRunner(registry).runSkillProposalEvaluate(evaluationEvent, ctx),
    ).resolves.toHaveLength(2);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("returns evaluator failures and timeouts as attributed outcomes", async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const registry = createMockPluginRegistry([
      {
        hookName: "skill_proposal_evaluate",
        pluginId: "throws",
        priority: 100,
        handler: () => {
          throw new Error("scanner unavailable\nprivate detail");
        },
      },
      {
        hookName: "skill_proposal_evaluate",
        pluginId: "hangs",
        priority: 50,
        timeoutMs: 1,
        handler: () => new Promise(() => undefined),
      },
    ]);

    const outcomes = await createHookRunner(registry, { logger }).runSkillProposalEvaluate(
      evaluationEvent,
      ctx,
    );

    expect(outcomes).toEqual([
      {
        evaluatorId: "throws",
        pluginId: "throws",
        status: "error",
        error: "scanner unavailable",
      },
      {
        evaluatorId: "hangs",
        pluginId: "hangs",
        status: "error",
        error: "timed out after 1ms",
      },
    ]);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("dispatches committed skill changes as observation hooks", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const registry = createMockPluginRegistry([
      { hookName: "skill_changed", pluginId: "first", handler: first },
      { hookName: "skill_changed", pluginId: "second", handler: second },
    ]);
    const event: PluginHookSkillChangedEvent = {
      action: "removed",
      source: "clawhub",
      occurredAt: "2026-07-29T00:00:00.000Z",
      before: {
        name: "Demo Skill",
        skillKey: "demo-skill",
        skillFile: "/workspace/skills/demo-skill/SKILL.md",
        skillDir: "/workspace/skills/demo-skill",
        source: "clawhub",
        revision: {
          contentSha256: "sha256:content",
          treeSha256: "sha256:tree",
          sourceVersion: "1.2.3",
        },
      },
    };

    await createHookRunner(registry).runSkillChanged(event, ctx);

    expect(first).toHaveBeenCalledWith(event, ctx);
    expect(second).toHaveBeenCalledWith(event, ctx);
  });
});
