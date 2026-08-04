// Control UI tests cover the Automations (cron) view behavior.
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import {
  createCronViewJob as createJob,
  renderCronView as renderView,
} from "./view.test-support.ts";

function getButtonByText(container: Element, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (btn) => btn.textContent?.replace(/\s+/g, " ").trim() === text,
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button with text "${text}"`);
  }
  return button;
}

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

function selectSegmented(control: HTMLElement) {
  const group = control.closest<HTMLElement & { value: string }>("wa-radio-group");
  expect(group).not.toBeNull();
  if (!group) {
    return;
  }
  group.value = control.getAttribute("value") ?? "";
  group.dispatchEvent(new Event("change", { bubbles: true }));
}

function findToggleByLabel(container: Element, label: string) {
  return (
    Array.from(container.querySelectorAll("wa-switch.settings-toggle")).find((toggle) =>
      toggle.textContent?.includes(label),
    ) ?? null
  );
}

describe("cron view list pane", () => {
  it("uses agent-scoped summary values", () => {
    const container = renderView({
      agentScoped: true,
      scopedTotal: 3,
      scopedNextWakeAtMs: Date.now() + 60_000,
      status: { enabled: true, jobs: 99, nextWakeAtMs: null },
    });
    const values = [...container.querySelectorAll(".cron-stat__value")].map((entry) =>
      entry.textContent?.trim(),
    );

    expect(values[0]).toBe("3");
    expect(values[2]).not.toBe("n/a");
  });

  it("hides an agent-scoped next wake while the scheduler is disabled", () => {
    const container = renderView({
      agentScoped: true,
      scopedNextWakeAtMs: Date.now() + 60_000,
      status: { enabled: false, jobs: 3, nextWakeAtMs: null },
    });
    const values = [...container.querySelectorAll(".cron-stat__value")].map((entry) =>
      entry.textContent?.trim(),
    );

    expect(values[2]).toBe("n/a");
  });

  it("keeps an agent-scoped next wake while scheduler status is loading", () => {
    const container = renderView({
      agentScoped: true,
      scopedNextWakeAtMs: Date.now() + 60_000,
      status: null,
    });
    const values = [...container.querySelectorAll(".cron-stat__value")].map((entry) =>
      entry.textContent?.trim(),
    );

    expect(values[2]).not.toBe("n/a");
  });

  it("wires the enabled tabs and marks the active one", () => {
    const onJobsFiltersChange = vi.fn();
    const container = renderView({ jobsEnabledFilter: "enabled", onJobsFiltersChange });

    const active = getElement(
      container,
      '[data-test-id="cron-tab-enabled"]',
      HTMLElement,
    ) as HTMLElement & { checked: boolean };
    expect(active.checked).toBe(true);
    expect(active.closest("wa-radio-group")?.querySelector('[slot="label"]')?.textContent).toBe(
      "Automation status",
    );

    selectSegmented(getElement(container, '[data-test-id="cron-tab-disabled"]', HTMLElement));
    expect(onJobsFiltersChange).toHaveBeenCalledWith({ cronJobsEnabledFilter: "disabled" });
  });

  it("wires search and the advanced jobs filter popover", () => {
    const onJobsFiltersChange = vi.fn();
    const container = renderView({ onJobsFiltersChange });

    const search = getElement(container, ".cron-search-box input", HTMLInputElement);
    search.value = "brief";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onJobsFiltersChange).toHaveBeenCalledWith({ cronJobsQuery: "brief" });

    const scheduleFilter = getElement(
      container,
      '[data-test-id="cron-jobs-schedule-filter"]',
      HTMLSelectElement,
    );
    scheduleFilter.value = "cron";
    scheduleFilter.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onJobsFiltersChange).toHaveBeenCalledWith({ cronJobsScheduleKindFilter: "cron" });

    const lastStatusFilter = getElement(
      container,
      '[data-test-id="cron-jobs-last-status-filter"]',
      HTMLSelectElement,
    );
    lastStatusFilter.value = "unknown";
    lastStatusFilter.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onJobsFiltersChange).toHaveBeenCalledWith({ cronJobsLastStatusFilter: "unknown" });

    const reset = getElement(
      container,
      '[data-test-id="cron-jobs-filters-reset"]',
      HTMLButtonElement,
    );
    expect(reset.disabled).toBe(true);
  });

  it("enables filter reset when advanced filters are active", () => {
    const onJobsFiltersReset = vi.fn();
    const container = renderView({ jobsScheduleKindFilter: "cron", onJobsFiltersReset });
    const reset = getElement(
      container,
      '[data-test-id="cron-jobs-filters-reset"]',
      HTMLButtonElement,
    );
    expect(reset.disabled).toBe(false);
    reset.click();
    expect(onJobsFiltersReset).toHaveBeenCalledTimes(1);
  });

  it("renders table rows with schedule and status cells and selects on click", () => {
    const onSelectJob = vi.fn();
    const job = createJob("job-1", { state: { nextRunAtMs: Date.now() + 60_000 } });
    const paused = createJob("job-2", { name: "Paused task", enabled: false });
    const failed = createJob("job-3", {
      name: "Failing task",
      state: { lastRunStatus: "error", lastRunAtMs: Date.now() - 60_000 },
    });
    const container = renderView({
      jobs: [job, paused, failed],
      onSelectJob,
    });

    const rows = Array.from(container.querySelectorAll(".cron-table__row"));
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain("Cron 0 9 * * *");
    expect(rows[1]?.classList.contains("cron-table__row--paused")).toBe(true);
    expect(rows[1]?.textContent).toContain("Paused");
    expect(rows[2]?.querySelector(".cron-table__dot--error")).not.toBeNull();
    expect(rows[2]?.querySelector(".cron-last-glyph--error")).not.toBeNull();
    expect(rows[2]?.querySelector(".cron-table__last-run")?.getAttribute("aria-label")).toBe(
      "Error",
    );
    expect(rows[0]?.querySelector(".cron-last-glyph--ok")).toBeNull();
    expect(rows[0]?.textContent).toContain("n/a");

    (rows[1] as HTMLElement).click();
    expect(onSelectJob).toHaveBeenCalledWith(paused);
  });

  it("keeps inline row actions from selecting the row", () => {
    const onSelectJob = vi.fn();
    const onRun = vi.fn();
    const onToggle = vi.fn();
    const job = createJob("job-1");
    const container = renderView({ jobs: [job], onSelectJob, onRun, onToggle });

    getElement(container, '[data-test-id="cron-row-run-job-1"]', HTMLButtonElement).click();
    expect(onRun).toHaveBeenCalledWith(job, "force");

    const toggle = getElement(container, '[data-test-id="cron-row-toggle-job-1"]', HTMLSpanElement);
    const toggleInput = getElement(toggle, "wa-switch", HTMLElement) as HTMLElement & {
      checked: boolean;
    };
    expect(toggleInput.checked).toBe(true);
    toggleInput.checked = false;
    toggleInput.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onToggle).toHaveBeenCalledWith(job, false);

    const runIfDue = Array.from(
      container.querySelectorAll(".cron-table__row .cron-job-menu__item"),
    ).find((item) => item.textContent?.trim() === "Run if due") as HTMLButtonElement;
    runIfDue
      .closest("wa-dropdown")
      ?.dispatchEvent(new CustomEvent("wa-select", { detail: { item: runIfDue }, bubbles: true }));
    expect(onRun).toHaveBeenCalledWith(job, "due");
    expect(onSelectJob).not.toHaveBeenCalled();
  });

  it("opens the create panel from the New task button and suggestions", () => {
    const onOpenCreate = vi.fn();
    const container = renderView({ onOpenCreate });

    getElement(container, '[data-test-id="cron-new-task"]', HTMLButtonElement).click();
    expect(onOpenCreate).toHaveBeenCalledWith();

    expect(container.querySelectorAll(".cron-suggestion")).toHaveLength(6);
    const suggestion = getElement(container, '[data-suggestion="repoPulse"]', HTMLButtonElement);
    suggestion.click();
    const patch = onOpenCreate.mock.calls.at(-1)?.[0];
    expect(patch).toMatchObject({
      payloadKind: "agentTurn",
      scheduleKind: "cron",
      cronExpr: "0 9 * * 1-5",
      deliveryMode: "announce",
      name: "Repo pulse",
    });
    expect(String(patch.payloadText)).toContain("overnight activity");
  });

  it("offers Create & run now only in create mode", () => {
    const onSubmitRunNow = vi.fn();
    const create = renderView({ createOpen: true, onSubmitRunNow });
    getElement(create, '[data-test-id="cron-submit-run"]', HTMLButtonElement).click();
    expect(onSubmitRunNow).toHaveBeenCalledTimes(1);

    const job = createJob("job-1");
    const editing = renderView({ jobs: [job], editingJobId: "job-1" });
    expect(editing.querySelector('[data-test-id="cron-submit-run"]')).toBeNull();
  });

  it("hides suggestions while any list filter is active", () => {
    expect(renderView({ jobsQuery: "x" }).querySelector(".cron-suggestion")).toBeNull();
    expect(
      renderView({ jobsEnabledFilter: "enabled" }).querySelector(".cron-suggestion"),
    ).toBeNull();
    expect(renderView().querySelector(".cron-suggestion")).not.toBeNull();
  });

  it("shows a scheduler banner only while the scheduler is off", () => {
    const off = renderView({
      status: { enabled: false, jobs: 2 },
      jobs: [createJob("job-1")],
      jobsTotal: 2,
    });
    const banner = getElement(off, '[data-test-id="cron-scheduler-banner"]', HTMLDivElement);
    expect(banner.textContent).toContain("Scheduler disabled");
    expect(getElement(off, ".cron-stats", HTMLDivElement).textContent).not.toContain("Scheduler");
    const footer = getElement(off, ".cron-table__footer", HTMLDivElement);
    expect(footer.textContent).toContain("1 of 2");

    const on = renderView({ status: { enabled: true, jobs: 2 } });
    expect(on.querySelector('[data-test-id="cron-scheduler-banner"]')).toBeNull();
  });

  it("shows the global failing count and drills into failing run history", () => {
    const onListTabChange = vi.fn();
    const onRunsFiltersChange = vi.fn();
    const container = renderView({ failingCount: 3, onListTabChange, onRunsFiltersChange });
    const value = getElement(container, ".cron-stat__value--danger", HTMLSpanElement);
    expect(value.textContent?.trim()).toBe("3");
    getElement(container, '[data-test-id="cron-stat-failing"]', HTMLButtonElement).click();
    expect(onListTabChange).toHaveBeenCalledWith("activity");
    expect(onRunsFiltersChange).toHaveBeenCalledWith({ cronRunsStatuses: ["error"] });

    const unknown = renderView({ failingCount: null });
    expect(unknown.querySelector(".cron-stat__value--danger")).toBeNull();
    const stats = getElement(unknown, ".cron-stats", HTMLDivElement);
    expect(stats.textContent).toContain("n/a");
  });

  it("switches between tasks and run history via the list tabs", () => {
    const onListTabChange = vi.fn();
    const tasks = renderView({ onListTabChange });
    expect(tasks.querySelector(".cron-table")).not.toBeNull();
    expect(tasks.querySelector(".cron-activity")).toBeNull();
    tasks
      .querySelector('[data-test-id="cron-list-tab-activity"]')
      ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    expect(onListTabChange).toHaveBeenCalledWith("activity");

    const activity = renderView({ listTab: "activity" });
    expect(activity.querySelector(".cron-table")).toBeNull();
    expect(activity.querySelector(".cron-activity")).not.toBeNull();
  });

  it("renders shared manual list tabs with active state and selection", () => {
    const onListTabChange = vi.fn();
    const container = renderView({ onListTabChange });
    document.body.append(container);
    const group = getElement(container, ".cron-list-hub-tabs", HTMLElement);
    const tasks = getElement(container, '[data-test-id="cron-list-tab-tasks"]', HTMLElement);
    const activity = getElement(container, '[data-test-id="cron-list-tab-activity"]', HTMLElement);

    expect(group.getAttribute("activation")).toBe("manual");
    expect(tasks.getAttribute("aria-selected")).toBe("true");
    expect(activity.getAttribute("aria-selected")).toBe("false");
    activity.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));

    expect(onListTabChange).toHaveBeenCalledWith("activity");
    expect(activity.getAttribute("aria-controls")).toBe("cron-list-panel");
    container.remove();
  });
});

describe("cron view run history", () => {
  it("renders runs sorted newest first and wires run filters", () => {
    const onRunsFiltersChange = vi.fn();
    const container = renderView({
      listTab: "activity",
      onRunsFiltersChange,
      runs: [
        { ts: 1_000, jobId: "job-1", status: "ok", summary: "older run" },
        { ts: 2_000, jobId: "job-2", status: "ok", summary: "newer run" },
      ],
      status: { enabled: true, jobs: 2 },
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
          status: "ok",
          summary: "total usage",
          durationMs: 90_000,
          usage: { total_tokens: 1_234_567 },
        },
        {
          ts: 3,
          jobId: "job-split",
          status: "ok",
          summary: "split usage",
          durationMs: 500,
          usage: { input_tokens: 50_000, output_tokens: 999 },
        },
        {
          ts: 2,
          jobId: "job-zero",
          status: "ok",
          summary: "zero duration",
          durationMs: 0,
        },
        {
          ts: 1.5,
          jobId: "job-invalid",
          status: "ok",
          summary: "invalid duration",
          durationMs: -1,
        },
        { ts: 1, jobId: "job-unknown", status: "ok", summary: "unknown duration" },
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
      runs: [{ ts: 1, jobId: "job-1", status: "error", error: "boom" }],
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

describe("cron view editor", () => {
  it("does not expose a tab panel when the selected job is unavailable", () => {
    const container = renderView({ editingJobId: "missing-job" });

    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('[role="tabpanel"]')).toBeNull();
  });

  it("renders the create view with prompt, general, and schedule cards", () => {
    const onSubmit = vi.fn();
    const onClosePanel = vi.fn();
    const container = renderView({ createOpen: true, onSubmit, onClosePanel });

    expect(container.querySelector(".cron-page--detail")?.textContent).toContain("New automation");
    expect(container.querySelector("#cron-payload-text")).toBeInstanceOf(HTMLTextAreaElement);
    expect(container.querySelector("#cron-name")).toBeInstanceOf(HTMLInputElement);
    expect(container.querySelector('[data-test-id="cron-schedule-kind-every"]')).toBeInstanceOf(
      HTMLElement,
    );
    // Create mode has no run-history tab and no enabled switch.
    expect(container.querySelector('[data-test-id="cron-detail-tab-history"]')).toBeNull();
    expect(container.querySelector('[data-test-id="cron-toggle-enabled"]')).toBeNull();

    // Generated controls take their accessible name from the row title label.
    const nameLabel = container.querySelector('label[for="cron-name"]');
    expect(nameLabel?.textContent).toContain("Name");
    expect(nameLabel?.textContent).toContain("required");
    expect(container.querySelector("#cron-name")?.getAttribute("aria-required")).toBe("true");
    const promptLabel = container.querySelector('label[for="cron-payload-text"]');
    expect(promptLabel?.textContent).toContain("required");
    // The payload-kind help renders as the prompt row's description.
    expect(promptLabel?.closest(".settings-row")?.textContent).toContain(
      "Starts an agent run in its own session using your prompt.",
    );

    getElement(container, '[data-test-id="cron-submit"]', HTMLButtonElement).click();
    expect(onSubmit).toHaveBeenCalledTimes(1);

    getElement(container, '[data-test-id="cron-back"]', HTMLButtonElement).click();
    expect(onClosePanel).toHaveBeenCalledTimes(1);
  });

  it("wires shared text and select controls without changing their field ownership", () => {
    const onFormChange = vi.fn();
    const container = renderView({
      createOpen: true,
      channels: ["telegram"],
      channelMeta: [{ id: "telegram", label: "", detailLabel: "Telegram" }],
      channelLabels: { telegram: "Telegram fallback" },
      form: { ...DEFAULT_CRON_FORM, scheduleKind: "cron", failureAlertMode: "custom" },
      onFormChange,
    });

    const prompt = getElement(container, "#cron-payload-text", HTMLTextAreaElement);
    prompt.value = "do the thing";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onFormChange).toHaveBeenCalledWith({ payloadText: "do the thing" });

    for (const field of ["name", "sessionKey", "deliveryAccountId", "payloadModel"] as const) {
      const id = `cron-${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
      const input = getElement(container, `#${id}`, HTMLInputElement);
      if (field === "sessionKey" || field === "deliveryAccountId") {
        expect(input.placeholder).toBe(field === "sessionKey" ? "agent:main:main" : "default");
      }
      input.value = field;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(onFormChange).toHaveBeenLastCalledWith({ [field]: field });
    }

    const channel = getElement(container, "#cron-failure-alert-channel", HTMLSelectElement);
    channel.value = "telegram";
    expect(channel.selectedOptions[0]?.textContent).toBe("Telegram fallback");
    channel.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onFormChange).toHaveBeenLastCalledWith({ failureAlertChannel: "telegram" });
  });

  it("switches schedule inputs by segmented kind and wires kind changes", () => {
    const onFormChange = vi.fn();
    const everyContainer = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, scheduleKind: "every" },
      onFormChange,
    });
    expect(everyContainer.querySelector("#cron-every-amount")).not.toBeNull();
    expect(everyContainer.querySelector("#cron-cron-expr")).toBeNull();
    const activeEvery = getElement(
      everyContainer,
      '[data-test-id="cron-schedule-kind-every"]',
      HTMLElement,
    ) as HTMLElement & { checked: boolean };
    expect(activeEvery.checked).toBe(true);
    selectSegmented(
      getElement(everyContainer, '[data-test-id="cron-schedule-kind-cron"]', HTMLElement),
    );
    expect(onFormChange).toHaveBeenCalledWith({
      scheduleKind: "cron",
      deleteAfterRun: false,
    });

    selectSegmented(
      getElement(everyContainer, '[data-test-id="cron-schedule-kind-at"]', HTMLElement),
    );
    expect(onFormChange).toHaveBeenCalledWith({
      scheduleKind: "at",
      deleteAfterRun: true,
    });

    const atContainer = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, scheduleKind: "at" },
    });
    expect(atContainer.querySelector("#cron-schedule-at")).not.toBeNull();

    const cronContainer = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, scheduleKind: "cron", deleteAfterRun: true },
      onFormChange,
    });
    expect(cronContainer.querySelector("#cron-cron-expr")).not.toBeNull();
    expect(findToggleByLabel(cronContainer, "Delete after run")).toBeNull();
    selectSegmented(
      getElement(cronContainer, '[data-test-id="cron-schedule-kind-every"]', HTMLElement),
    );
    expect(onFormChange).toHaveBeenCalledWith({
      scheduleKind: "every",
      deleteAfterRun: false,
    });

    // on-exit jobs keep a pill so they can convert to an editable schedule;
    // the on-exit pill only exists while it is the current value.
    const onExitContainer = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, scheduleKind: "on-exit" },
    });
    expect(
      onExitContainer.querySelector('[data-test-id="cron-schedule-kind-on-exit"]'),
    ).not.toBeNull();
    expect(findToggleByLabel(onExitContainer, "Delete after run")).not.toBeNull();
    expect(everyContainer.querySelector('[data-test-id="cron-schedule-kind-on-exit"]')).toBeNull();
    const onExitFormChange = vi.fn();
    const keptOnExitContainer = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, scheduleKind: "on-exit", deleteAfterRun: false },
      onFormChange: onExitFormChange,
    });
    selectSegmented(
      getElement(keptOnExitContainer, '[data-test-id="cron-schedule-kind-at"]', HTMLElement),
    );
    expect(onExitFormChange).toHaveBeenCalledWith({ scheduleKind: "at" });
  });

  it("shows a live schedule summary when inputs are valid", () => {
    const plural = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, scheduleKind: "every", everyAmount: "30" },
    });
    expect(plural.querySelector(".cron-schedule-summary")?.textContent).toContain(
      "Runs every 30 minutes",
    );

    const singular = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, scheduleKind: "every", everyAmount: "1", everyUnit: "hours" },
    });
    expect(singular.querySelector(".cron-schedule-summary")?.textContent).toContain(
      "Runs every hour",
    );

    const invalid = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, scheduleKind: "every", everyAmount: "" },
    });
    expect(invalid.querySelector(".cron-schedule-summary")).toBeNull();

    // One-shot summaries render the parsed date/time, not a duration.
    const once = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, scheduleKind: "at", scheduleAt: "2026-07-14T09:00" },
    });
    const onceText = once.querySelector(".cron-schedule-summary")?.textContent ?? "";
    expect(onceText).toContain("Runs once at");
    expect(onceText).toContain("2026");
  });

  it("offers a Seconds interval unit so sub-minute cadences stay editable", () => {
    const container = renderView({
      createOpen: true,
      form: {
        ...DEFAULT_CRON_FORM,
        scheduleKind: "every",
        everyAmount: "30",
        everyUnit: "seconds",
      },
    });
    const unitSelect = getElement(container, 'select[aria-label="Unit"]', HTMLSelectElement);
    const values = Array.from(unitSelect.querySelectorAll("option")).map((option) => option.value);
    expect(values).toEqual(["seconds", "minutes", "hours", "days"]);
  });

  it("summarizes seconds intervals, including singular and decimal amounts", () => {
    const singular = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, scheduleKind: "every", everyAmount: "1", everyUnit: "seconds" },
    });
    expect(singular.querySelector(".cron-schedule-summary")?.textContent).toContain(
      "Runs every second",
    );

    const plural = renderView({
      createOpen: true,
      form: {
        ...DEFAULT_CRON_FORM,
        scheduleKind: "every",
        everyAmount: "30",
        everyUnit: "seconds",
      },
    });
    expect(plural.querySelector(".cron-schedule-summary")?.textContent).toContain(
      "Runs every 30 seconds",
    );

    const decimal = renderView({
      createOpen: true,
      form: {
        ...DEFAULT_CRON_FORM,
        scheduleKind: "every",
        everyAmount: "0.45",
        everyUnit: "seconds",
      },
    });
    expect(decimal.querySelector(".cron-schedule-summary")?.textContent).toContain(
      "Runs every 0.45 seconds",
    );
  });

  it("hides the schedule summary for recurring amounts that cannot produce safe milliseconds", () => {
    for (const everyAmount of ["0x10", "1e3", "+1", String(Number.MAX_SAFE_INTEGER), "0.000001"]) {
      const container = renderView({
        createOpen: true,
        form: { ...DEFAULT_CRON_FORM, scheduleKind: "every", everyAmount },
      });
      expect(container.querySelector(".cron-schedule-summary")).toBeNull();
    }
  });

  it("renders supported delivery options and normalizes stale announce selection", () => {
    // systemEvent + main session cannot announce; a stale announce selection
    // must render as none and the announce option must disappear.
    const container = renderView({
      createOpen: true,
      form: {
        ...DEFAULT_CRON_FORM,
        sessionTarget: "main",
        payloadKind: "systemEvent",
        deliveryMode: "announce",
      },
    });
    const delivery = getElement(container, "#cron-delivery-mode", HTMLSelectElement);
    const values = Array.from(delivery.querySelectorAll("option")).map((option) => option.value);
    expect(values).toEqual(["webhook", "none"]);
    expect(container.querySelector("#cron-delivery-channel")).toBeNull();
  });

  it("shows announce channel/to rows and webhook URL row per delivery mode", () => {
    const announce = renderView({
      createOpen: true,
      channels: ["telegram"],
      form: { ...DEFAULT_CRON_FORM, deliveryMode: "announce" },
    });
    expect(announce.querySelector("#cron-delivery-channel")).not.toBeNull();
    expect(announce.querySelector("#cron-delivery-to")).not.toBeNull();

    const webhook = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, deliveryMode: "webhook" },
      fieldErrors: { deliveryTo: "cron.errors.webhookUrlRequired" },
      canSubmit: false,
    });
    const urlInput = getElement(webhook, "#cron-delivery-to", HTMLInputElement);
    expect(urlInput.getAttribute("aria-invalid")).toBe("true");
    expect(urlInput.getAttribute("aria-describedby")).toBe("cron-error-deliveryTo");
    expect(webhook.querySelector("#cron-error-deliveryTo")?.textContent).toContain(
      "Webhook URL is required.",
    );
  });

  it("shows model and reasoning rows only for agent-turn payloads", () => {
    const agentTurn = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, payloadKind: "agentTurn" },
    });
    expect(agentTurn.querySelector("#cron-payload-model")).not.toBeNull();
    expect(agentTurn.querySelector("#cron-payload-thinking")).not.toBeNull();

    const systemEvent = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, payloadKind: "systemEvent", sessionTarget: "main" },
    });
    expect(systemEvent.querySelector("#cron-payload-model")).toBeNull();
  });

  it("renders script payloads as highlighted read-only code without exposing script authoring", () => {
    const script = "const result = await agent('check status')";
    const job = createJob("job-script", {
      name: "Status script",
      payload: { kind: "script", script },
    });
    const container = renderView({
      jobs: [job],
      editingJobId: job.id,
      form: {
        ...DEFAULT_CRON_FORM,
        name: job.name,
        payloadKind: "script",
        payloadLocked: true,
        payloadText: script,
      },
    });

    const payload = getElement(container, "#cron-payload-text", HTMLPreElement);
    expect(payload.textContent).toBe(script);
    expect(payload.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(payload.querySelector(".hljs-string")?.textContent).toBe("'check status'");
    expect(container.querySelector("textarea#cron-payload-text")).toBeNull();
    expect(container.querySelector("#cron-payload-kind")?.getAttribute("value")).toBeNull();
    expect((container.querySelector("#cron-payload-kind") as HTMLInputElement).value).toBe(
      "Script",
    );
    expect(container.textContent).toContain("contents stay read-only");
    expect(container.querySelector('option[value="script"]')).toBeNull();
  });

  it("highlights locked command payloads as shell and keeps heartbeat payloads plain", () => {
    const job = createJob("job-command", {
      name: "Backup",
      payload: { kind: "script", script: "" },
    });
    const command = renderView({
      jobs: [job],
      editingJobId: job.id,
      form: {
        ...DEFAULT_CRON_FORM,
        name: job.name,
        payloadKind: "command",
        payloadLocked: true,
        payloadText: "echo $HOME",
      },
    });
    const payload = getElement(command, "#cron-payload-text", HTMLPreElement);
    expect(payload.textContent).toBe("echo $HOME");
    expect(payload.querySelector(".hljs-built_in")?.textContent).toBe("echo");

    const heartbeat = renderView({
      jobs: [job],
      editingJobId: job.id,
      form: {
        ...DEFAULT_CRON_FORM,
        name: job.name,
        payloadKind: "heartbeat",
        payloadLocked: true,
        payloadText: "",
      },
    });
    expect(heartbeat.querySelector("#cron-payload-text")).toBeInstanceOf(HTMLTextAreaElement);
  });

  it("disables submit and lists blocking fields when validation fails", () => {
    const container = renderView({
      createOpen: true,
      canSubmit: false,
      form: { ...DEFAULT_CRON_FORM, name: "" },
      fieldErrors: { name: "cron.errors.nameRequired" },
    });
    const submit = getElement(container, '[data-test-id="cron-submit"]', HTMLButtonElement);
    expect(submit.disabled).toBe(true);
    const statusLinks = Array.from(container.querySelectorAll(".cron-form-status__link"));
    expect(statusLinks.some((link) => link.textContent?.includes("Name"))).toBe(true);
    expect(container.textContent).toContain("Fix 1 field to continue.");
  });

  it("renders job mode with header actions and detail tabs", () => {
    const onRun = vi.fn();
    const onToggle = vi.fn();
    const onClone = vi.fn();
    const onRemove = vi.fn();
    const onDetailTabChange = vi.fn();
    const job = createJob("job-1", { name: "Nightly digest" });
    const container = renderView({
      jobs: [job],
      editingJobId: "job-1",
      onRun,
      onToggle,
      onClone,
      onRemove,
      onDetailTabChange,
    });

    expect(getElement(container, ".cron-detail-title", HTMLDivElement).textContent).toContain(
      "Nightly digest",
    );
    expect(getButtonByText(container, "Save changes")).toBeInstanceOf(HTMLButtonElement);

    getElement(container, '[data-test-id="cron-run-now"]', HTMLButtonElement).click();
    expect(onRun).toHaveBeenCalledWith(job, "force");

    const toggle = getElement(container, '[data-test-id="cron-toggle-enabled"]', HTMLSpanElement);
    const toggleInput = getElement(toggle, "wa-switch", HTMLElement) as HTMLElement & {
      checked: boolean;
    };
    expect(toggleInput.checked).toBe(true);
    expect(toggle.textContent).toContain("Active");
    toggleInput.checked = false;
    toggleInput.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onToggle).toHaveBeenCalledWith(job, false);

    const jobMenu = container.querySelector("wa-dropdown.cron-job-menu");
    const runIfDue = jobMenu?.querySelector<HTMLElement>('wa-dropdown-item[value="run-if-due"]');
    if (runIfDue) {
      jobMenu?.dispatchEvent(
        new CustomEvent("wa-select", { detail: { item: runIfDue }, bubbles: true }),
      );
    }
    expect(onRun).toHaveBeenCalledWith(job, "due");
    const clone = jobMenu?.querySelector<HTMLElement>('wa-dropdown-item[value="clone"]');
    if (clone) {
      jobMenu?.dispatchEvent(
        new CustomEvent("wa-select", { detail: { item: clone }, bubbles: true }),
      );
    }
    expect(onClone).toHaveBeenCalledWith(job);
    const remove = jobMenu?.querySelector<HTMLElement>('wa-dropdown-item[value="remove"]');
    if (remove) {
      jobMenu?.dispatchEvent(
        new CustomEvent("wa-select", { detail: { item: remove }, bubbles: true }),
      );
    }
    expect(onRemove).toHaveBeenCalledWith(job);

    expect(
      container
        .querySelector('[data-test-id="cron-detail-tab-settings"]')
        ?.getAttribute("aria-selected"),
    ).toBe("true");
    container
      .querySelector('[data-test-id="cron-detail-tab-history"]')
      ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    expect(onDetailTabChange).toHaveBeenCalledWith("history");
  });

  it.each([true, false])("preserves task browsing for canManage=%s", (canManage) => {
    const job = createJob("permission-job");
    const onSelectJob = vi.fn();
    const container = renderView({ canManage, jobs: [job], onSelectJob });

    expect(Boolean(container.querySelector('[data-test-id="cron-new-task"]'))).toBe(canManage);
    expect(Boolean(container.querySelector('[data-test-id="cron-row-run-permission-job"]'))).toBe(
      canManage,
    );
    expect(Boolean(container.querySelector("wa-dropdown.cron-job-menu"))).toBe(canManage);
    getElement(container, '[data-test-id="cron-row-permission-job"]', HTMLDivElement).click();
    expect(onSelectJob).toHaveBeenCalledWith(job);
  });

  it("keeps read-only operators on browse surfaces without mutation controls", () => {
    const onSelectJob = vi.fn();
    const job = createJob("job-1", {
      name: "Nightly digest",
      description: "Read-only operators can inspect this task",
    });
    const list = renderView({ canManage: false, jobs: [job], jobsTotal: 1, onSelectJob });

    expect(list.textContent).toContain("Browsing only");
    expect(list.querySelector('[data-test-id="cron-new-task"]')).toBeNull();
    expect(list.querySelector('[data-test-id="cron-row-run-job-1"]')).toBeNull();
    expect(list.querySelector('[data-test-id="cron-row-toggle-job-1"]')).toBeNull();
    expect(list.querySelector("wa-dropdown.cron-job-menu")).toBeNull();
    expect(list.querySelector("[data-suggestion]")).toBeNull();
    expect(list.querySelector(".cron-table__description")?.textContent).toContain(job.description);

    getElement(list, '[data-test-id="cron-row-job-1"]', HTMLDivElement).click();
    expect(onSelectJob).toHaveBeenCalledWith(job);

    const detail = renderView({ canManage: false, jobs: [job], editingJobId: job.id });
    expect(detail.textContent).toContain("Browsing only");
    expect(detail.querySelector('[data-test-id="cron-run-now"]')).toBeNull();
    expect(detail.querySelector('[data-test-id="cron-toggle-enabled"]')).toBeNull();
    expect(detail.querySelector("wa-dropdown.cron-job-menu")).toBeNull();
    expect(detail.querySelector('[data-test-id="cron-submit"]')).toBeNull();
    expect(detail.querySelector(".cron-editor-actions")).toBeNull();
    expect(getElement(detail, ".cron-editor", HTMLFieldSetElement).disabled).toBe(true);
    expect(detail.querySelector('[data-test-id="cron-detail-tab-history"]')).not.toBeNull();
    expect(detail.querySelector('[data-test-id="cron-detail-description"]')?.textContent).toContain(
      job.description,
    );
  });

  it("locks the editor and back navigation while a save is pending", () => {
    const job = createJob("job-1", { name: "Nightly digest" });
    const container = renderView({ jobs: [job], editingJobId: "job-1", busy: true });

    const editor = getElement(container, ".cron-editor", HTMLFieldSetElement);
    const name = getElement(container, "#cron-name", HTMLInputElement);
    const back = getElement(container, '[data-test-id="cron-back"]', HTMLButtonElement);
    const submit = getElement(container, '[data-test-id="cron-submit"]', HTMLButtonElement);

    expect(editor.disabled).toBe(true);
    expect(editor.getAttribute("aria-busy")).toBe("true");
    expect(name.matches(":disabled")).toBe(true);
    expect(back.disabled).toBe(true);
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toContain("Saving");
  });

  it("shows run history instead of the editor on the history tab", () => {
    const job = createJob("job-1", {
      name: "Nightly digest",
      description: "Saved description stays visible in history",
    });
    const container = renderView({
      jobs: [job],
      editingJobId: "job-1",
      detailTab: "history",
      runs: [{ ts: 5, jobId: "job-1", jobName: "Nightly digest", status: "ok", summary: "ran" }],
    });
    expect(container.querySelector(".cron-run-entry")).not.toBeNull();
    expect(container.querySelector(".cron-editor")).toBeNull();
    expect(
      container.querySelector('[data-test-id="cron-detail-description"]')?.textContent,
    ).toContain(job.description);
  });

  it("shows the paused switch state for disabled jobs", () => {
    const onToggle = vi.fn();
    const job = createJob("job-1", { enabled: false });
    const container = renderView({ jobs: [job], editingJobId: "job-1", onToggle });
    const toggle = getElement(container, '[data-test-id="cron-toggle-enabled"]', HTMLSpanElement);
    const toggleInput = getElement(toggle, "wa-switch", HTMLElement) as HTMLElement & {
      checked: boolean;
    };
    expect(toggleInput.checked).toBe(false);
    expect(toggle.textContent).toContain("Paused");
    toggleInput.checked = true;
    toggleInput.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onToggle).toHaveBeenCalledWith(job, true);
  });

  it("renders suggestion datalists for agent/model/thinking/timezone", () => {
    const container = renderView({
      createOpen: true,
      agentSuggestions: ["main"],
      modelSuggestions: ["openai/gpt-5.2"],
      thinkingSuggestions: ["low"],
      timezoneSuggestions: ["UTC"],
      deliveryToSuggestions: ["+15551234"],
      accountSuggestions: ["default"],
    });
    for (const id of [
      "cron-agent-suggestions",
      "cron-model-suggestions",
      "cron-thinking-suggestions",
      "cron-tz-suggestions",
      "cron-delivery-to-suggestions",
      "cron-delivery-account-suggestions",
    ]) {
      expect(container.querySelector(`datalist#${id}`)).not.toBeNull();
    }
    const model = getElement(container, "#cron-payload-model", HTMLInputElement);
    expect(model.getAttribute("list")).toBe("cron-model-suggestions");
  });
});
