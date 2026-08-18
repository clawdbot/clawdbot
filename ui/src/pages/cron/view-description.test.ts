import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../../api/types.ts";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import { createCronViewJob, renderCronView } from "./view.test-support.ts";

const payloadCases = [
  { kind: "systemEvent", payload: { kind: "systemEvent", text: "check status" } },
  { kind: "agentTurn", payload: { kind: "agentTurn", message: "Summarize updates" } },
  { kind: "command", payload: { kind: "command", argv: ["echo", "ready"] } },
  { kind: "script", payload: { kind: "script", script: "return 'ready'" } },
  { kind: "heartbeat", payload: { kind: "heartbeat" } },
] satisfies Array<{ kind: CronJob["payload"]["kind"]; payload: CronJob["payload"] }>;

describe("cron view saved descriptions", () => {
  it.each(payloadCases)(
    "shows the saved description inline for $kind tasks without changing row selection",
    ({ kind, payload }) => {
      const onSelectJob = vi.fn();
      const job = createCronViewJob(`described-${kind}`, {
        description: "  Summarize overnight deployment activity  ",
        payload,
      });
      const container = renderCronView({ jobs: [job], onSelectJob });
      const description = container.querySelector<HTMLSpanElement>(
        `[data-test-id="cron-row-description-${job.id}"]`,
      );

      expect(description).toBeInstanceOf(HTMLSpanElement);
      expect(description?.textContent?.trim()).toBe("· Summarize overnight deployment activity");
      expect(description?.title).toBe("Description: Summarize overnight deployment activity");
      description?.click();
      expect(onSelectJob).toHaveBeenCalledWith(job);
    },
  );

  it.each([undefined, "", "  \n\t  "])(
    "omits the inline description when the saved description is %j",
    (description) => {
      const job = createCronViewJob("without-description", { description });
      const container = renderCronView({ jobs: [job] });

      expect(container.querySelector(".cron-table__description")).toBeNull();
    },
  );

  it("renders saved descriptions as escaped text", () => {
    const description = '<img src="x" onerror="alert(1)"> & <script>alert(1)</script>';
    const job = createCronViewJob("escaped-description", { description });
    const container = renderCronView({ jobs: [job] });

    expect(container.querySelector(".cron-table__description")?.textContent).toContain(description);
    expect(container.querySelector(".cron-table__name img")).toBeNull();
    expect(container.querySelector(".cron-table__name script")).toBeNull();
  });

  it.each(payloadCases)(
    "shows the saved $kind task description instead of unsaved form edits",
    ({ kind, payload }) => {
      const job = createCronViewJob(`saved-${kind}`, {
        description: "  Saved description for the selected task  ",
        payload,
      });
      const container = renderCronView({
        jobs: [],
        editingJob: job,
        form: { ...DEFAULT_CRON_FORM, description: "Unsaved description edit" },
      });
      const description = container.querySelector('[data-test-id="cron-detail-description"]');

      expect(description).toBeInstanceOf(HTMLDivElement);
      expect(description?.textContent?.replace(/\s+/g, " ").trim()).toBe(
        "Description: Saved description for the selected task",
      );
      expect(description?.textContent).not.toContain("Unsaved description edit");
    },
  );

  it.each([undefined, "", "  \n\t  "])(
    "omits the detail description when the saved description is %j",
    (description) => {
      const job = createCronViewJob("without-description", { description });
      const container = renderCronView({ jobs: [], editingJob: job });

      expect(container.querySelector('[data-test-id="cron-detail-description"]')).toBeNull();
    },
  );
});
