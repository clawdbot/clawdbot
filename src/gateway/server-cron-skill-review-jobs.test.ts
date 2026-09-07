import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CronService } from "../cron/service.js";
import { saveCronJobsStore } from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "Review the Workshop collection." },
    state: {},
  } as CronJob;
}

describe("reconcileSkillCollectionReviewJobs", () => {
  it.each(["duplicate", "add", "stale"] as const)(
    "lets the event loop progress between %s attempts after a row failure",
    async (phase) => {
      let progressed = false;
      let checkpoint: Promise<void> | undefined;
      const observed: Array<{ id: string; progressed: boolean }> = [];
      const recordAttempt = (id: string) => {
        observed.push({ id, progressed });
        if (observed.length === 1) {
          checkpoint = new Promise((resolve) => {
            setImmediate(() => {
              progressed = true;
              resolve();
            });
          });
          throw new Error("first mutation failed");
        }
      };
      const add = vi.fn(async (input: { agentId: string }) => {
        if (phase === "add") {
          recordAttempt(input.agentId);
        }
        return monitorJob(input.agentId);
      });
      const remove = vi.fn(async (id: string) => {
        if ((phase === "duplicate" && id.startsWith("duplicate-")) || phase === "stale") {
          recordAttempt(id);
        }
        return { ok: true, removed: true };
      });
      const jobs =
        phase === "duplicate"
          ? [
              monitorJob("a"),
              ...["one", "two", "three"].map((id) => monitorJob("a", `duplicate-${id}`)),
            ]
          : phase === "stale"
            ? [monitorJob("old-a"), monitorJob("old-b"), monitorJob("old-c")]
            : [];
      try {
        const result = await reconcileSkillCollectionReviewJobs({
          cron: { add, remove, list: vi.fn(async () => jobs) } as never,
          cfg: { agents: { ownership: "explicit", entries: { a: {}, b: {}, c: {} } } },
          logger,
        });
        expect(result).toEqual({ ok: false });
        const ids =
          phase === "duplicate"
            ? ["duplicate-one", "duplicate-two", "duplicate-three"]
            : phase === "stale"
              ? ["job-old-a", "job-old-b", "job-old-c"]
              : ["a", "b", "c"];
        expect(observed).toEqual(ids.map((id, index) => ({ id, progressed: index > 0 })));
      } finally {
        await checkpoint;
      }
    },
  );

  it("rejects stale authority after yielding before another cleanup call", async () => {
    const revoked = new Error("reconciliation revoked");
    let current = true;
    let checkpoint: Promise<void> | undefined;
    const commitGuard = () => {
      if (!current) {
        throw revoked;
      }
    };
    const remove = vi.fn(async (_id: string, options?: { commitGuard?: () => void }) => {
      options?.commitGuard?.();
      checkpoint ??= new Promise((resolve) => {
        setImmediate(() => {
          current = false;
          resolve();
        });
      });
      return { ok: true, removed: true };
    });
    try {
      await expect(
        reconcileSkillCollectionReviewJobs({
          cron: {
            remove,
            add: vi.fn(async () => monitorJob("main")),
            list: vi.fn(async () => [monitorJob("stale-a"), monitorJob("stale-b")]),
          } as never,
          cfg: { agents: { entries: { main: {} } } },
          logger,
          commitGuard,
        }),
      ).rejects.toBe(revoked);
      expect(remove).toHaveBeenCalledTimes(1);
    } finally {
      await checkpoint;
    }
  });

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
        declarationKey: "user:collider",
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

    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls[0]?.[0]).toMatchObject({
      declarationKey: "skill-collection-review:main",
      enabled: false,
      payload: {
        kind: "agentTurn",
      },
    });
    expect(add.mock.calls[0]?.[1]).toMatchObject({
      enabledExplicit: true,
      systemOwned: true,
    });
    expect(add.mock.calls.map(([input]) => input.declarationKey)).toEqual([
      "skill-collection-review:main",
      "skill-collection-review:ops",
    ]);
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

  it("replaces retired jobs on the current database and converges once per agent after restart", async () => {
    const testState = await createOpenClawTestState({ label: "skill-review-convergence" });
    const storePath = testState.statePath("cron", "jobs.json");
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", list: [{ id: "main", default: true }, { id: "ops" }] },
    };
    const deps = {
      storePath,
      cronEnabled: false,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    };
    let cron = new CronService(deps);
    try {
      const old = {
        ...monitorJob("main"),
        sessionTarget: "main",
        payload: { kind: "skillCollectionReview" },
      };
      await saveCronJobsStore(storePath, { version: 1, jobs: [monitorJob("main")] });
      const db = openOpenClawStateDatabase().db;
      const version = db.prepare("PRAGMA user_version").get();
      db.prepare("UPDATE cron_jobs SET payload_kind = ?, job_json = ? WHERE job_id = ?").run(
        "skillCollectionReview",
        JSON.stringify(old),
        old.id,
      );
      await expect(reconcileSkillCollectionReviewJobs({ cron, cfg, logger })).resolves.toEqual({
        ok: true,
      });
      const first = await cron.list({ includeDisabled: true });
      expect(first).toHaveLength(2);
      expect(first.map((job) => job.agentId)).toEqual(expect.arrayContaining(["main", "ops"]));
      for (const job of first) {
        expect(job).toMatchObject({
          sessionTarget: "isolated",
          payload: { kind: "agentTurn" },
          delivery: { mode: "none" },
        });
      }
      expect(first.some((job) => job.id === old.id)).toBe(false);
      cron.stop();
      cron = new CronService(deps);
      await expect(reconcileSkillCollectionReviewJobs({ cron, cfg, logger })).resolves.toEqual({
        ok: true,
      });
      expect(await cron.list({ includeDisabled: true })).toEqual(first);
      expect(db.prepare("PRAGMA user_version").get()).toEqual(version);
    } finally {
      cron.stop();
      await testState.cleanup();
    }
  });

  it("revokes an active review through gateway reconciliation before its final write", async () => {
    const testState = await createOpenClawTestState({ label: "skill-review-revoke" });
    const workspaceDir = testState.workspaceDir;
    const finalWritePath = path.join(workspaceDir, "skills", "candidate", "SKILL.md");
    const started = createDeferred<AbortSignal>();
    const release = createDeferred();
    const settled = createDeferred();
    const runIsolatedAgentJob = vi.fn(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
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
    });
    const cron = new CronService({
      storePath: testState.statePath("cron", "jobs.json"),
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
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
      await testState.cleanup();
    }
  });
});
