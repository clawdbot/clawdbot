import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../../api/types.ts";
import { createAgentViewTestProps } from "./agents-view.test-helpers.ts";
import { renderAgents } from "./view.ts";

describe("agent automation actions", () => {
  it.each([
    { name: "enabled job", enabled: true, canRunCron: true, canRun: true },
    { name: "paused job", enabled: false, canRunCron: true, canRun: true },
    { name: "job without cron access", enabled: true, canRunCron: false, canRun: false },
    { name: "paused job without cron access", enabled: false, canRunCron: false, canRun: false },
  ])("gates manual execution of a $name on operator access", ({ enabled, canRunCron, canRun }) => {
    const job: CronJob = {
      id: "manual-run",
      name: "Scheduled job",
      enabled,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron", expr: "0 9 * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "ping" },
      state: {},
    };
    const defaults = createAgentViewTestProps();
    const onCronRunNow = vi.fn();
    const container = document.createElement("div");

    render(
      renderAgents(
        createAgentViewTestProps({
          activePanel: "cron",
          access: { ...defaults.access, canRunCron },
          cron: { ...defaults.cron, jobs: [job], jobsTotal: 1, scopedTotal: 1 },
          onCronRunNow,
        }),
      ),
      container,
    );

    const jobRow = Array.from(container.querySelectorAll(".settings-row")).find(
      (row) => row.querySelector(".settings-row__title")?.textContent === job.name,
    );
    const runNow = jobRow?.querySelector<HTMLButtonElement>("button");
    expect(runNow).toBeInstanceOf(HTMLButtonElement);
    expect(runNow?.disabled).toBe(!canRun);

    runNow?.click();
    if (canRun) {
      expect(onCronRunNow).toHaveBeenCalledWith(job.id);
    } else {
      expect(onCronRunNow).not.toHaveBeenCalled();
    }
  });
});
