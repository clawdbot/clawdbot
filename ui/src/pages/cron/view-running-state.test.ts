// Running-state rendering for the Automations (cron) table.
// Lives beside view.test.ts, which sits at the max-lines cap.
import { expect, it } from "vitest";
import {
  createCronViewJob as createJob,
  renderCronView as renderView,
} from "./view.test-support.ts";

it("shows Running instead of a past-due next-run time while a run executes", () => {
  const running = createJob("job-running", {
    state: { nextRunAtMs: Date.now() - 600_000, runningAtMs: Date.now() - 60_000 },
  });
  const container = renderView({ jobs: [running] });
  const row = container.querySelector(".cron-table__row");
  expect(row?.querySelector(".cron-table__running")?.textContent).toBe("Running");
  expect(row?.querySelector(".cron-table__state--running")?.getAttribute("aria-label")).toBe(
    "Running",
  );
  expect(row?.textContent).not.toContain("ago");
});
