import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSkillCollectionReviewMonitorSpecs } from "./skill-collection-review-monitor.js";

describe("resolveSkillCollectionReviewMonitorSpecs", () => {
  it("creates one stable seven-day job for every agent", () => {
    const cfg = {
      agents: {
        list: [
          { id: "main", default: true, workspace: "/tmp/openclaw-shared" },
          { id: "ops", workspace: "/tmp/openclaw-shared" },
          { id: "solo", workspace: "/tmp/openclaw-solo" },
        ],
        defaults: { model: "anthropic/claude-sonnet-4-6" },
      },
      skills: { workshop: { autonomous: { mode: "auto" } } },
    } as OpenClawConfig;

    const specs = resolveSkillCollectionReviewMonitorSpecs(cfg, [], {
      schedulerSeed: "test-seed",
    });

    expect(specs.map(({ agentId }) => agentId)).toEqual(["main", "ops", "solo"]);
    expect(specs.map(({ input }) => input.declarationKey)).toEqual([
      "skill-collection-review:main",
      "skill-collection-review:ops",
      "skill-collection-review:solo",
    ]);
    expect(specs[0]?.input).toMatchObject({
      name: "skill-collection-review-main",
      displayName: "Skill collection review (main)",
      enabled: true,
      payload: {
        kind: "agentTurn",
        message: expect.any(String),
        toolsAllow: ["ls", "read", "write", "edit", "apply_patch", "exec", "process"],
      },
      schedule: {
        kind: "every",
        everyMs: 7 * 24 * 60 * 60_000,
        anchorMs: expect.any(Number),
      },
      sessionTarget: "isolated",
      delivery: { mode: "none" },
      wakeMode: "next-heartbeat",
    });
    expect(specs[0]?.input.payload).not.toHaveProperty("toolsAllowIsDefault");
    const repeated = resolveSkillCollectionReviewMonitorSpecs(cfg, [], {
      schedulerSeed: "test-seed",
    });
    expect(repeated.map(({ input }) => input.schedule)).toEqual(
      specs.map(({ input }) => input.schedule),
    );
  });

  it("creates jobs for every agent in an explicit fleet", () => {
    const explicitFleet = {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    } as unknown as OpenClawConfig;
    expect(
      resolveSkillCollectionReviewMonitorSpecs(explicitFleet, []).map(({ agentId }) => agentId),
    ).toEqual(["ops", "research"]);

    const systemAgentFleet = {
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
        defaults: { systemAgent: { agentId: "research" } },
      },
    } as unknown as OpenClawConfig;
    expect(
      resolveSkillCollectionReviewMonitorSpecs(systemAgentFleet, []).map(({ agentId }) => agentId),
    ).toEqual(["ops", "research"]);
  });

  it("retains monitor rows while autonomous review is disabled", () => {
    const cfg = {
      agents: { list: [{ id: "main", workspace: "/tmp/openclaw-disabled" }] },
      skills: { workshop: { autonomous: { mode: "propose" } } },
    } as OpenClawConfig;

    const [spec] = resolveSkillCollectionReviewMonitorSpecs(cfg, [], {
      schedulerSeed: "test-seed",
    });
    expect(spec?.input.enabled).toBe(false);
    expect(spec?.input.displayName).not.toContain("no-rooted-runtime");
  });

  it("disables only agents whose complete configured chain cannot enforce the review root", () => {
    const cfg = {
      agents: {
        defaults: { model: "anthropic/claude-sonnet-4-6" },
        list: [
          {
            id: "blocked",
            model: {
              primary: "openai/gpt-blocked",
              fallbacks: ["openai/gpt-still-blocked"],
            },
            models: {
              "openai/gpt-blocked": { agentRuntime: { id: "codex" } },
              "openai/gpt-still-blocked": { agentRuntime: { id: "codex" } },
            },
          },
          {
            id: "fallback",
            model: {
              primary: "openai/gpt-blocked",
              fallbacks: ["anthropic/claude-sonnet-4-6"],
            },
            models: {
              "openai/gpt-blocked": { agentRuntime: { id: "codex" } },
            },
          },
          { id: "embedded", model: "anthropic/claude-sonnet-4-6" },
          { id: "implicit", model: "openai/gpt-5.2" },
          { id: "cli", model: "claude-cli/claude-opus-4-6" },
        ],
      },
      skills: { workshop: { autonomous: { mode: "auto" } } },
    } as OpenClawConfig;

    const byAgent = new Map(
      resolveSkillCollectionReviewMonitorSpecs(cfg, []).map((spec) => [spec.agentId, spec.input]),
    );

    expect(byAgent.get("blocked")).toMatchObject({
      enabled: false,
      displayName: expect.stringContaining("no-rooted-runtime"),
    });
    for (const agentId of ["fallback", "embedded", "implicit", "cli"]) {
      expect(byAgent.get(agentId)?.enabled).toBe(true);
      expect(byAgent.get(agentId)?.displayName).not.toContain("no-rooted-runtime");
    }
  });
  it("keeps an executable agent-scoped review alias enabled", () => {
    const cfg = {
      agents: {
        defaults: { model: "openai/gpt-blocked" },
        list: [
          {
            id: "reviewer",
            subagents: { model: "review" },
            models: {
              "openai/gpt-blocked": { agentRuntime: { id: "codex" } },
              "openai/review": { agentRuntime: { id: "codex" } },
              "anthropic/claude-sonnet-4-6": { alias: "review" },
            },
          },
        ],
      },
      skills: { workshop: { autonomous: { mode: "auto" } } },
    } as OpenClawConfig;
    const [spec] = resolveSkillCollectionReviewMonitorSpecs(cfg, []);
    expect(spec?.input.enabled).toBe(true);
    expect(spec?.input.displayName).not.toContain("no-rooted-runtime");
  });

  it("does not disable a runnable default when an advisory subagent model can be rejected", () => {
    const cfg = {
      agents: {
        defaults: { model: "anthropic/claude-sonnet-4-6" },
        list: [
          {
            id: "reviewer",
            subagents: { model: "openai/gpt-blocked" },
            modelPolicy: { allow: ["anthropic/claude-sonnet-4-6"] },
            models: { "openai/gpt-blocked": { agentRuntime: { id: "codex" } } },
          },
        ],
      },
      skills: { workshop: { autonomous: { mode: "auto" } } },
    } as OpenClawConfig;
    const [spec] = resolveSkillCollectionReviewMonitorSpecs(cfg, []);
    expect(spec?.input.enabled).toBe(true);
    expect(spec?.input.displayName).not.toContain("no-rooted-runtime");
  });
});
