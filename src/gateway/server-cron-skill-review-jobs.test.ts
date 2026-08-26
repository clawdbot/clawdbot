import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import { reconcileSkillCollectionReviewJobs } from "./server-cron-skill-review-jobs.js";

const logger = { warn: vi.fn() };

function monitorJob(agentId: string, id = `job-${agentId}`): CronJob {
  return {
    id,
    declarationKey: `skill-collection-review:${agentId}`,
    name: `skill-collection-review-${agentId}`,
    displayName: `Skill collection review (${agentId})`,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    agentId,
    schedule: { kind: "every", everyMs: 7 * 24 * 60 * 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "skillCollectionReview" },
    state: {},
  } as CronJob;
}

describe("reconcileSkillCollectionReviewJobs", () => {
  it("adds desired monitors, keeps disabled rows, and prunes stale monitors", async () => {
    const add = vi.fn(
      async (
        input: { declarationKey?: string },
        _options?: { enabledExplicit?: boolean; systemOwned?: boolean },
      ) => ({ job: input }),
    );
    const remove = vi.fn(async () => ({ ok: true }));
    const list = vi.fn(async () => [
      monitorJob("main"),
      monitorJob("stale"),
      {
        ...monitorJob("collider"),
        id: "user-job",
        payload: { kind: "systemEvent", text: "user job" },
      } as CronJob,
    ]);
    const cfg = {
      agents: {
        list: [
          { id: "main", default: true, workspace: "/tmp/openclaw-shared" },
          { id: "ops", workspace: "/tmp/openclaw-shared" },
        ],
      },
      skills: { workshop: { autonomous: { mode: "propose" } } },
    } as OpenClawConfig;

    await reconcileSkillCollectionReviewJobs({
      cron: { add, list, remove } as never,
      cfg,
      logger,
    });

    expect(add).toHaveBeenCalledOnce();
    expect(add.mock.calls[0]?.[0]).toMatchObject({
      declarationKey: "skill-collection-review:main",
      enabled: false,
      payload: { kind: "skillCollectionReview" },
    });
    expect(add.mock.calls[0]?.[1]).toMatchObject({
      enabledExplicit: true,
      systemOwned: true,
    });
    expect(remove).toHaveBeenCalledWith("job-stale", { systemOwned: true });
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
