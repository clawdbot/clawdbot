import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CronService } from "../cron/service.js";
import type { CronJob } from "../cron/types.js";
import { reconcileSkillCollectionReviewJobs } from "./server-cron-skill-review-jobs.js";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

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
      monitorJob("stale", "stale-older"),
      { ...monitorJob("stale", "stale-newer"), updatedAtMs: 2 },
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
    expect(remove).toHaveBeenNthCalledWith(1, "stale-older", { systemOwned: true });
    expect(remove).toHaveBeenNthCalledWith(2, "stale-newer", { systemOwned: true });
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("removes duplicate monitors before converging their declaration", async () => {
    const older = monitorJob("main", "older");
    const newer = { ...monitorJob("main", "newer"), updatedAtMs: 2 };
    const jobs = [older, newer];
    const remove = vi.fn(async (jobId: string) => {
      const index = jobs.findIndex((job) => job.id === jobId);
      if (index >= 0) {
        jobs.splice(index, 1);
      }
      return { ok: true };
    });
    const add = vi.fn(
      async (_input: unknown, options?: { matchesExisting?: (job: CronJob) => boolean }) => {
        const matches = jobs.filter((job) => options?.matchesExisting?.(job));
        if (matches.length > 1) {
          throw new Error("ambiguous declaration key");
        }
        return { job: matches[0] };
      },
    );
    const cfg = {
      agents: { list: [{ id: "main", default: true, workspace: "/tmp/openclaw-main" }] },
      skills: { workshop: { autonomous: { mode: "propose" } } },
    } as OpenClawConfig;

    await expect(
      reconcileSkillCollectionReviewJobs({
        cron: { add, list: vi.fn(async () => jobs), remove } as never,
        cfg,
        logger,
      }),
    ).resolves.toEqual({ ok: true });

    expect(remove).toHaveBeenNthCalledWith(1, "older", { systemOwned: true });
    expect(add).toHaveBeenCalledOnce();
  });

  it("revokes an active review through gateway reconciliation before its final write", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-review-revoke-"));
    const workspaceDir = path.join(rootDir, "workspace");
    const finalWritePath = path.join(workspaceDir, "skills", "candidate", "SKILL.md");
    const started = createDeferred<AbortSignal>();
    const release = createDeferred();
    const settled = createDeferred();
    const runSkillCollectionReview = vi.fn(
      async ({ abortSignal }: { agentId: string; abortSignal?: AbortSignal }) => {
        if (!abortSignal) {
          throw new Error("skill review cancellation signal missing");
        }
        started.resolve(abortSignal);
        try {
          await release.promise;
          abortSignal.throwIfAborted();
          await fs.mkdir(path.dirname(finalWritePath), { recursive: true });
          await fs.writeFile(finalWritePath, "review output", "utf8");
          return { status: "ok" as const, summary: "reviewed main" };
        } finally {
          settled.resolve();
        }
      },
    );
    const cron = new CronService({
      storePath: path.join(rootDir, "cron", "jobs.json"),
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runSkillCollectionReview,
    });
    const config = (mode: "auto" | "off") =>
      ({
        agents: {
          list: [{ id: "main", default: true, workspace: workspaceDir }],
        },
        skills: { workshop: { autonomous: { mode } } },
      }) satisfies OpenClawConfig;
    let activeRun: Promise<unknown> | undefined;

    try {
      await cron.start();
      await reconcileSkillCollectionReviewJobs({
        cron,
        cfg: config("auto"),
        logger,
      });
      const monitor = (await cron.list({ includeDisabled: true })).find(
        (job) => job.declarationKey === "skill-collection-review:main",
      );
      if (!monitor) {
        throw new Error("skill review monitor missing after gateway reconciliation");
      }

      activeRun = cron.run(monitor.id, "force");
      const abortSignal = await started.promise;
      await reconcileSkillCollectionReviewJobs({
        cron,
        cfg: config("off"),
        logger,
      });

      expect(abortSignal.aborted).toBe(true);
      release.resolve();
      await settled.promise;
      await activeRun;
      await expect(fs.access(finalWritePath)).rejects.toThrow();
      expect(cron.getJob(monitor.id)?.enabled).toBe(false);
    } finally {
      release.resolve();
      await activeRun?.catch(() => undefined);
      cron.stop();
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
