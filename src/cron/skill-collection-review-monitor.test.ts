import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSkillCollectionReviewMonitorSpecs } from "./skill-collection-review-monitor.js";

describe("resolveSkillCollectionReviewMonitorSpecs", () => {
  it("creates one stable seven-day job regardless of agent count", () => {
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

    expect(specs.map(({ agentId }) => agentId)).toEqual(["main"]);
    expect(specs.map(({ input }) => input.declarationKey)).toEqual([
      "skill-collection-review:main",
    ]);
    expect(specs[0]?.input).toMatchObject({
      name: "skill-collection-review-main",
      displayName: "Skill collection review (main)",
      enabled: true,
      payload: { kind: "skillCollectionReview" },
      schedule: {
        kind: "every",
        everyMs: 7 * 24 * 60 * 60_000,
        anchorMs: expect.any(Number),
      },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    });
    const repeated = resolveSkillCollectionReviewMonitorSpecs(cfg, {
      schedulerSeed: "test-seed",
    });
    expect(repeated[0]?.input.schedule).toEqual(specs[0]?.input.schedule);
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
