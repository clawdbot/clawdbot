import { describe, expect, it, vi } from "vitest";
import { renderCronView as renderView } from "./view.test-support.ts";

function getElement<T extends Element>(
  container: Element,
  selector: string,
  constructor: new () => T,
): T {
  const element = container.querySelector<T>(selector);
  expect(element).toBeInstanceOf(constructor);
  if (!(element instanceof constructor)) {
    throw new Error(`Expected ${selector} to match ${constructor.name}`);
  }
  return element;
}

describe("cron view run history", () => {
  it("renders runs sorted newest first and wires run filters", () => {
    const onRunsFiltersChange = vi.fn();
    const container = renderView({
      listTab: "activity",
      onRunsFiltersChange,
      runs: [
        { ts: 1_000, jobId: "job-1", action: "finished", status: "ok", summary: "older run" },
        { ts: 2_000, jobId: "job-2", action: "finished", status: "ok", summary: "newer run" },
      ],
      status: { enabled: true, triggersEnabled: true, jobs: 2 },
    });

    const titles = Array.from(container.querySelectorAll(".cron-run-entry__title")).map((el) =>
      el.textContent?.trim(),
    );
    expect(titles[0]).toContain("job-2");
    expect(titles[1]).toContain("job-1");

    const search = getElement(container, ".cron-run-filter-search input", HTMLInputElement);
    search.value = "fail";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onRunsFiltersChange).toHaveBeenCalledWith({ cronRunsQuery: "fail" });

    const statusOption = container.querySelector<HTMLElement & { checked: boolean }>(
      '[data-filter="status"] wa-dropdown-item[value="option:error"]',
    );
    expect(statusOption).not.toBeNull();
    statusOption
      ?.closest("wa-dropdown")
      ?.dispatchEvent(
        new CustomEvent("wa-select", { detail: { item: statusOption }, bubbles: true }),
      );
    expect(onRunsFiltersChange).toHaveBeenCalledWith({ cronRunsStatuses: ["error"] });

    const clearCommand = container.querySelector<HTMLElement>(
      '[data-filter="status"] wa-dropdown-item[value="command:clear"]',
    );
    clearCommand
      ?.closest("wa-dropdown")
      ?.dispatchEvent(
        new CustomEvent("wa-select", { detail: { item: clearCommand }, bubbles: true }),
      );
    expect(onRunsFiltersChange).toHaveBeenCalledWith({ cronRunsStatuses: [] });
  });

  it("formats run token counts and durations in the rendered entry", () => {
    const container = renderView({
      listTab: "activity",
      runs: [
        {
          ts: 4,
          jobId: "job-total",
          action: "finished",
          status: "ok",
          summary: "total usage",
          durationMs: 90_000,
          usage: { total_tokens: 1_234_567 },
        },
        {
          ts: 3,
          jobId: "job-split",
          action: "finished",
          status: "ok",
          summary: "split usage",
          durationMs: 500,
          usage: { input_tokens: 50_000, output_tokens: 999 },
        },
        {
          ts: 2,
          jobId: "job-zero",
          action: "finished",
          status: "ok",
          summary: "zero duration",
          durationMs: 0,
        },
        {
          ts: 1.5,
          jobId: "job-invalid",
          action: "finished",
          status: "ok",
          summary: "invalid duration",
          durationMs: -1,
        },
        {
          ts: 1,
          jobId: "job-unknown",
          action: "finished",
          status: "ok",
          summary: "unknown duration",
        },
      ],
    });
    const entries = Array.from(container.querySelectorAll(".cron-run-entry"));
    const entryFor = (jobId: string) => {
      const entry = entries.find((candidate) =>
        candidate.querySelector(".cron-run-entry__title")?.textContent?.includes(jobId),
      );
      expect(entry).toBeInstanceOf(HTMLDivElement);
      return entry;
    };

    const total = entryFor("job-total");
    expect(total?.querySelector(".cron-run-entry__facts")?.textContent).toContain("1.2M Tokens");
    expect(total?.querySelector(".cron-run-entry__meta")?.textContent).toContain("1m 30s");
    expect(total?.textContent).not.toContain("1234567");
    expect(total?.textContent).not.toContain("90000ms");

    const split = entryFor("job-split");
    expect(split?.querySelector(".cron-run-entry__facts")?.textContent).toContain(
      "50k in / 999 out",
    );
    expect(split?.querySelector(".cron-run-entry__meta")?.textContent).toContain("500ms");
    expect(entryFor("job-zero")?.querySelector(".cron-run-entry__meta")?.textContent).toContain(
      "0ms",
    );
    expect(entryFor("job-invalid")?.querySelector(".cron-run-entry__meta")?.textContent).toContain(
      "n/a",
    );
    expect(entryFor("job-unknown")?.querySelector(".cron-run-entry__meta")?.textContent).toContain(
      "n/a",
    );
  });

  it("renders run summaries as sanitized markdown", () => {
    const container = renderView({
      listTab: "activity",
      runs: [
        {
          ts: 1,
          jobId: "job-1",
          action: "finished",
          status: "ok",
          summary: "**bold** <script>alert(1)</script>",
        },
      ],
    });
    const body = getElement(container, ".cron-run-entry__body", HTMLDivElement);
    expect(body.querySelector("strong")?.textContent).toBe("bold");
    expect(body.querySelector("script")).toBeNull();
  });

  it("shows run errors as the body when no summary exists", () => {
    const container = renderView({
      listTab: "activity",
      runs: [{ ts: 1, jobId: "job-1", action: "finished", status: "error", error: "boom" }],
    });
    const body = getElement(container, ".cron-run-entry__body", HTMLDivElement);
    expect(body.textContent).toContain("boom");
  });

  it("distinguishes an unfiltered empty state from filtered no-matches", () => {
    const empty = renderView({ listTab: "activity" });
    expect(empty.querySelector(".cron-empty-state")?.textContent).toContain("No runs yet");

    const filtered = renderView({ listTab: "activity", runsQuery: "fail" });
    expect(filtered.querySelector(".cron-runs__empty")?.textContent).toContain("No matching runs.");
  });
});
