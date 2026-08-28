// Auto-disabled state rendering for the Automations (cron) table.
// Lives beside view.test.ts, which sits at the max-lines cap.
import { expect, it } from "vitest";
import {
  createCronViewJob as createJob,
  renderCronView as renderView,
} from "./view.test-support.ts";

it("labels an auto-disabled job distinctly from an operator pause", () => {
  const paused = createJob("job-paused", { enabled: false });
  const autoDisabled = createJob("job-auto", {
    enabled: false,
    state: {
      lastRunStatus: "error",
      lastError: "provider exploded",
      autoDisabled: { reason: "consecutive-failures", atMs: 1, consecutiveErrors: 10 },
    },
  });
  const container = renderView({ jobs: [paused, autoDisabled] });
  const rows = Array.from(container.querySelectorAll(".cron-table__row"));
  expect(rows[0]?.textContent).toContain("Paused");
  expect(rows[0]?.querySelector(".cron-table__state--paused")?.getAttribute("aria-label")).toBe(
    "Paused",
  );
  const note = rows[1]?.querySelector("[data-test-id='cron-row-auto-disabled-job-auto']");
  expect(note?.textContent?.trim()).toBe("Auto-disabled · 10 run failures");
  expect(note?.getAttribute("title")).toBe("provider exploded");
  // Escalated failure keeps a visible error marker even though the job is disabled.
  expect(rows[1]?.querySelector(".cron-table__state--error")?.getAttribute("aria-label")).toBe(
    "Auto-disabled · 10 run failures",
  );
});
