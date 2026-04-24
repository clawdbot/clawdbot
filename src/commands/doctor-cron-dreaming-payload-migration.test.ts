import { describe, expect, it } from "vitest";
import {
  countStaleDreamingJobs,
  migrateLegacyDreamingPayloadShape,
} from "./doctor-cron-dreaming-payload-migration.js";

const DREAMING_TOKEN = "__openclaw_memory_core_short_term_promotion_dream__";
const DREAMING_TAG = "[managed-by=memory-core.short-term-promotion]";

function staleDreamingJob() {
  return {
    id: "job-1",
    name: "Memory Dreaming Promotion",
    description: `${DREAMING_TAG} Promote weighted short-term recalls.`,
    enabled: true,
    schedule: { kind: "cron", expr: "0 3 * * *" },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: DREAMING_TOKEN },
  } as Record<string, unknown>;
}

function migratedDreamingJob() {
  return {
    id: "job-1",
    name: "Memory Dreaming Promotion",
    description: `${DREAMING_TAG} Promote weighted short-term recalls.`,
    enabled: true,
    schedule: { kind: "cron", expr: "0 3 * * *" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: DREAMING_TOKEN, lightContext: true },
    delivery: { mode: "none" },
  } as Record<string, unknown>;
}

describe("migrateLegacyDreamingPayloadShape", () => {
  it("rewrites stale main-session dreaming jobs to isolated agentTurn shape", () => {
    const jobs = [staleDreamingJob()];
    const result = migrateLegacyDreamingPayloadShape(jobs);
    expect(result).toEqual({ changed: true, rewrittenCount: 1 });
    expect(jobs[0]).toMatchObject({
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: DREAMING_TOKEN, lightContext: true },
      delivery: { mode: "none" },
    });
  });

  it("identifies the managed job by description tag even when name was edited", () => {
    const jobs = [{ ...staleDreamingJob(), name: "Custom Name" }];
    const result = migrateLegacyDreamingPayloadShape(jobs);
    expect(result.rewrittenCount).toBe(1);
    expect(jobs[0]).toMatchObject({ sessionTarget: "isolated" });
  });

  it("identifies the managed job by name + payload token when description tag is missing", () => {
    const job = staleDreamingJob();
    delete job.description;
    const jobs = [job];
    const result = migrateLegacyDreamingPayloadShape(jobs);
    expect(result.rewrittenCount).toBe(1);
  });

  it("is idempotent on already-migrated jobs", () => {
    const jobs = [migratedDreamingJob()];
    const result = migrateLegacyDreamingPayloadShape(jobs);
    expect(result).toEqual({ changed: false, rewrittenCount: 0 });
    expect(jobs[0]).toEqual(migratedDreamingJob());
  });

  it("re-applies missing pieces (e.g. lightContext flag) on partially-migrated jobs", () => {
    const job = migratedDreamingJob();
    (job.payload as Record<string, unknown>).lightContext = false;
    const jobs = [job];
    const result = migrateLegacyDreamingPayloadShape(jobs);
    expect(result.rewrittenCount).toBe(1);
    expect((jobs[0]?.payload as Record<string, unknown>).lightContext).toBe(true);
  });

  it("normalizes delivery to mode=none when omitted on an isolated dreaming job", () => {
    const job = migratedDreamingJob();
    delete job.delivery;
    const jobs = [job];
    const result = migrateLegacyDreamingPayloadShape(jobs);
    expect(result.rewrittenCount).toBe(1);
    expect(jobs[0]?.delivery).toEqual({ mode: "none" });
  });

  it("leaves unrelated cron jobs untouched", () => {
    const unrelated = {
      id: "job-2",
      name: "Daily Standup Reminder",
      description: "Reminds the team",
      enabled: true,
      schedule: { kind: "cron", expr: "0 9 * * 1-5" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "good morning" },
    } as Record<string, unknown>;
    const snapshot = JSON.parse(JSON.stringify(unrelated)) as Record<string, unknown>;
    const jobs = [unrelated];
    const result = migrateLegacyDreamingPayloadShape(jobs);
    expect(result).toEqual({ changed: false, rewrittenCount: 0 });
    expect(jobs[0]).toEqual(snapshot);
  });

  it("ignores look-alike jobs whose payload token does not match", () => {
    const lookalike = staleDreamingJob();
    delete lookalike.description;
    (lookalike.payload as Record<string, unknown>).text = "some other system event";
    const jobs = [lookalike];
    const result = migrateLegacyDreamingPayloadShape(jobs);
    expect(result.rewrittenCount).toBe(0);
    expect(jobs[0]?.sessionTarget).toBe("main");
  });

  it("processes a mixed batch correctly", () => {
    const jobs = [
      staleDreamingJob(),
      {
        id: "job-other",
        name: "Other",
        description: "x",
        enabled: true,
        schedule: { kind: "cron", expr: "0 0 * * *" },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "hi" },
      },
      migratedDreamingJob(),
    ] as Array<Record<string, unknown>>;
    const result = migrateLegacyDreamingPayloadShape(jobs);
    expect(result).toEqual({ changed: true, rewrittenCount: 1 });
    expect(jobs[0]).toMatchObject({ sessionTarget: "isolated" });
    expect(jobs[1]).toMatchObject({ sessionTarget: "main" });
    expect(jobs[2]).toEqual(migratedDreamingJob());
  });
});

describe("countStaleDreamingJobs", () => {
  it("counts fully-stale legacy jobs", () => {
    expect(countStaleDreamingJobs([staleDreamingJob()])).toBe(1);
  });

  it("counts partially-migrated jobs (e.g. lightContext flipped to false)", () => {
    const partial = migratedDreamingJob();
    (partial.payload as Record<string, unknown>).lightContext = false;
    expect(countStaleDreamingJobs([partial])).toBe(1);
  });

  it("counts partially-migrated jobs missing delivery", () => {
    const partial = migratedDreamingJob();
    delete partial.delivery;
    expect(countStaleDreamingJobs([partial])).toBe(1);
  });

  it("returns 0 for fully-migrated jobs", () => {
    expect(countStaleDreamingJobs([migratedDreamingJob()])).toBe(0);
  });

  it("ignores unrelated jobs", () => {
    expect(
      countStaleDreamingJobs([
        {
          id: "x",
          name: "Other",
          description: "",
          enabled: true,
          schedule: { kind: "cron", expr: "* * * * *" },
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "hi" },
        },
      ]),
    ).toBe(0);
  });
});
