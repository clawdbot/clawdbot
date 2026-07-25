import { afterEach, describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import {
  bumpSessionAutomationVersion,
  claimSessionAutomationEpoch,
  registerSessionAutomationSource,
  sessionHasAutomation,
  unregisterSessionAutomationSource,
} from "./session-automation-index.js";

const cfg = {} as OpenClawConfig;

function job(partial: Partial<CronJob> & Pick<CronJob, "id">): CronJob {
  return { enabled: true, sessionTarget: "isolated", ...partial } as CronJob;
}

afterEach(() => {
  registerSessionAutomationSource(null);
});

describe("session automation index", () => {
  test("reports sessions bound to enabled jobs", () => {
    const jobs = [job({ id: "a" }), job({ id: "b", enabled: false })];
    registerSessionAutomationSource({
      getJobs: () => jobs,
      getDefaultAgentId: () => "main",
    });
    expect(sessionHasAutomation("agent:main:cron:a", cfg)).toBe(true);
    expect(sessionHasAutomation("agent:main:cron:b", cfg)).toBe(false);
    expect(sessionHasAutomation("agent:main:main", cfg)).toBe(false);
  });

  test("version bumps invalidate the memo after in-place job mutations", () => {
    const jobs = [job({ id: "a" })];
    registerSessionAutomationSource({
      getJobs: () => jobs,
      getDefaultAgentId: () => "main",
    });
    expect(sessionHasAutomation("agent:main:cron:a", cfg)).toBe(true);
    (jobs[0] as { enabled: boolean }).enabled = false;
    bumpSessionAutomationVersion();
    expect(sessionHasAutomation("agent:main:cron:a", cfg)).toBe(false);
  });

  test("unregistering the source clears automation state", () => {
    registerSessionAutomationSource({
      getJobs: () => [job({ id: "a" })],
      getDefaultAgentId: () => "main",
    });
    expect(sessionHasAutomation("agent:main:cron:a", cfg)).toBe(true);
    registerSessionAutomationSource(null);
    expect(sessionHasAutomation("agent:main:cron:a", cfg)).toBe(false);
  });

  test("reports false before the cron store is loaded", () => {
    registerSessionAutomationSource({
      getJobs: () => undefined,
      getDefaultAgentId: () => "main",
    });
    expect(sessionHasAutomation("agent:main:cron:a", cfg)).toBe(false);
  });

  test("stale services cannot clobber or clear a replacement registration", () => {
    const staleEpoch = claimSessionAutomationEpoch();
    const staleSource = {
      getJobs: () => [job({ id: "stale" })],
      getDefaultAgentId: () => "main",
    };
    const freshEpoch = claimSessionAutomationEpoch();
    const freshSource = {
      getJobs: () => [job({ id: "fresh" })],
      getDefaultAgentId: () => "main",
    };
    registerSessionAutomationSource(freshSource, freshEpoch);
    // Config-reload race: the older service's start resolves late.
    registerSessionAutomationSource(staleSource, staleEpoch);
    expect(sessionHasAutomation("agent:main:cron:fresh", cfg)).toBe(true);
    expect(sessionHasAutomation("agent:main:cron:stale", cfg)).toBe(false);
    unregisterSessionAutomationSource(staleSource);
    expect(sessionHasAutomation("agent:main:cron:fresh", cfg)).toBe(true);
    unregisterSessionAutomationSource(freshSource);
    expect(sessionHasAutomation("agent:main:cron:fresh", cfg)).toBe(false);
  });
});
