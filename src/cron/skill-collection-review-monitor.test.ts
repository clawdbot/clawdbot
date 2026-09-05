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
        defaults: {},
      },
      skills: { workshop: { autonomous: { mode: "auto" } } },
    } as OpenClawConfig;

    const specs = resolveSkillCollectionReviewMonitorSpecs(cfg, {
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
        toolsAllow: ["read", "write", "edit", "apply_patch", "exec", "process"],
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
    const repeated = resolveSkillCollectionReviewMonitorSpecs(cfg, {
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
      resolveSkillCollectionReviewMonitorSpecs(explicitFleet).map(({ agentId }) => agentId),
    ).toEqual(["ops", "research"]);

    const systemAgentFleet = {
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
        defaults: { systemAgent: { agentId: "research" } },
      },
    } as unknown as OpenClawConfig;
    expect(
      resolveSkillCollectionReviewMonitorSpecs(systemAgentFleet).map(({ agentId }) => agentId),
    ).toEqual(["ops", "research"]);
  });

  it("retains monitor rows while autonomous review is disabled", () => {
    const cfg = {
      agents: { list: [{ id: "main", workspace: "/tmp/openclaw-disabled" }] },
      skills: { workshop: { autonomous: { mode: "propose" } } },
    } as OpenClawConfig;

    const [spec] = resolveSkillCollectionReviewMonitorSpecs(cfg, {
      schedulerSeed: "test-seed",
    });
    expect(spec?.input.enabled).toBe(false);
  });
});
