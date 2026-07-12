import { describe, expect, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  disableCronJobsBoundToSession,
  resolveCronJobBoundSessionKeys,
  type CronJobSessionBinding,
} from "./job-session-bindings.js";
import type { CronJob } from "./types.js";

const cfg = {} as OpenClawConfig;

function bindingKeys(job: CronJobSessionBinding, defaultAgentId?: string) {
  return resolveCronJobBoundSessionKeys(job, { cfg, defaultAgentId });
}

describe("resolveCronJobBoundSessionKeys", () => {
  test("isolated jobs bind their deterministic cron session", () => {
    expect(bindingKeys({ id: "job1", sessionTarget: "isolated" })).toEqual(
      new Set(["agent:main:cron:job1"]),
    );
  });

  test("isolated jobs keep the deterministic run session plus the sessionKey lane", () => {
    expect(
      bindingKeys({
        id: "job1",
        agentId: "ops",
        sessionKey: "discord:channel:99",
        sessionTarget: "isolated",
      }),
    ).toEqual(new Set(["agent:ops:cron:job1", "agent:ops:discord:channel:99"]));
  });

  test("persisted current targets bind the deterministic run session", () => {
    expect(bindingKeys({ id: "job1", sessionTarget: "current" })).toEqual(
      new Set(["agent:main:cron:job1"]),
    );
  });

  test("main-target jobs bind the agent main session", () => {
    expect(bindingKeys({ id: "job1", agentId: "ops", sessionTarget: "main" })).toEqual(
      new Set(["agent:ops:main"]),
    );
  });

  test("session targets scope unqualified keys to the job agent", () => {
    expect(bindingKeys({ id: "job1", sessionTarget: "session:discord:group:dev" }, "ops")).toEqual(
      new Set(["agent:ops:discord:group:dev"]),
    );
  });

  test("session targets keep already-scoped keys on their own agent", () => {
    expect(bindingKeys({ id: "job1", sessionTarget: "session:agent:ops:slack:group:x" })).toEqual(
      new Set(["agent:ops:slack:group:x"]),
    );
  });

  test("wake/delivery sessionKey lanes bind in addition to the run target", () => {
    expect(
      bindingKeys({
        id: "job1",
        sessionTarget: "main",
        sessionKey: "discord:channel:123",
      }),
    ).toEqual(new Set(["agent:main:main", "agent:main:discord:channel:123"]));
  });

  test("malformed session targets bind nothing instead of throwing", () => {
    expect(bindingKeys({ id: "job1", sessionTarget: "session: " })).toEqual(new Set());
  });
});

describe("disableCronJobsBoundToSession", () => {
  function job(partial: Partial<CronJob> & Pick<CronJob, "id">): CronJob {
    return { enabled: true, sessionTarget: "isolated", ...partial } as CronJob;
  }

  type Precondition = (job: CronJob, nowMs: number) => void | Promise<void>;

  function fakeUpdateWithPrecondition(currentJobs: () => CronJob[]) {
    return vi.fn(async (id: string, _patch: unknown, precondition: Precondition) => {
      const current = currentJobs().find((candidate) => candidate.id === id);
      if (!current) {
        throw new Error(`cron job not found: ${id}`);
      }
      await precondition(current, 0);
      return current;
    });
  }

  test("disables only enabled jobs bound to the archived session", async () => {
    const jobs = [
      job({ id: "bound" }),
      job({ id: "other", sessionTarget: "session:agent:main:other" }),
      // Bound to the same session but already disabled; must not be re-patched.
      job({ id: "already-off", enabled: false, sessionKey: "cron:bound" }),
    ];
    const update = fakeUpdateWithPrecondition(() => jobs);
    const disabled = await disableCronJobsBoundToSession({
      cron: {
        list: async () => jobs,
        updateWithPrecondition: update,
        getDefaultAgentId: () => "main",
      },
      cfg,
      sessionKey: "agent:main:cron:bound",
    });
    expect(disabled).toEqual(["bound"]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.slice(0, 2)).toEqual(["bound", { enabled: false }]);
  });

  test("returns empty when nothing is bound", async () => {
    const update = fakeUpdateWithPrecondition(() => [job({ id: "elsewhere" })]);
    const disabled = await disableCronJobsBoundToSession({
      cron: {
        list: async () => [job({ id: "elsewhere" })],
        updateWithPrecondition: update,
        getDefaultAgentId: () => undefined,
      },
      cfg,
      sessionKey: "agent:main:slack:group:x",
    });
    expect(disabled).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });

  test("skips jobs retargeted between the list snapshot and the locked update", async () => {
    const listed = [job({ id: "bound" })];
    // The locked current job now targets a different session.
    const retargeted = [job({ id: "bound", sessionTarget: "session:agent:main:elsewhere" })];
    const update = fakeUpdateWithPrecondition(() => retargeted);
    const disabled = await disableCronJobsBoundToSession({
      cron: {
        list: async () => listed,
        updateWithPrecondition: update,
        getDefaultAgentId: () => "main",
      },
      cfg,
      sessionKey: "agent:main:cron:bound",
    });
    expect(disabled).toEqual([]);
    expect(update).toHaveBeenCalledTimes(1);
  });

  test("a failing job does not abort the remaining bound jobs", async () => {
    const listed = [job({ id: "vanished", sessionKey: "cron:bound" }), job({ id: "bound" })];
    // "vanished" was removed concurrently; the fake only knows "bound".
    const update = fakeUpdateWithPrecondition(() => [job({ id: "bound" })]);
    await expect(
      disableCronJobsBoundToSession({
        cron: {
          list: async () => listed,
          updateWithPrecondition: update,
          getDefaultAgentId: () => "main",
        },
        cfg,
        sessionKey: "agent:main:cron:bound",
      }),
    ).rejects.toThrow(AggregateError);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls.map((call) => call[0])).toEqual(["vanished", "bound"]);
  });
});
