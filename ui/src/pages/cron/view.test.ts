// Control UI tests cover the Automations (cron) list pane and select controls.
import { describe, expect, it, vi } from "vitest";
import {
  createCronViewJob as createJob,
  getElement,
  renderCronView as renderView,
  selectSegmented,
} from "./view.test-support.ts";

describe("cron view list pane", () => {
  it.each([
    { name: "an enabled scheduler", status: { enabled: true }, hasNextWake: true },
    { name: "a disabled scheduler", status: { enabled: false }, hasNextWake: false },
    { name: "loading scheduler status", status: null, hasNextWake: true },
  ])("uses agent-scoped summary values for $name", ({ status, hasNextWake }) => {
    const container = renderView({
      agentScoped: true,
      scopedTotal: 3,
      scopedNextWakeAtMs: Date.now() + 60_000,
      status: status ? { ...status, triggersEnabled: true, jobs: 99, nextWakeAtMs: null } : null,
    });
    const values = [...container.querySelectorAll(".cron-stat__value")].map((entry) =>
      entry.textContent?.trim(),
    );

    expect(values[0]).toBe("3");
    expect(values[2] !== "n/a").toBe(hasNextWake);
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
    expect(Array.from(scheduleFilter.options, (option) => option.value)).toEqual([
      "all",
      "at",
      "every",
      "cron",
      "on-exit",
      "stream",
    ]);
    for (const scheduleKind of ["on-exit", "stream"] as const) {
      scheduleFilter.value = scheduleKind;
      scheduleFilter.dispatchEvent(new Event("change", { bubbles: true }));
      expect(onJobsFiltersChange).toHaveBeenCalledWith({
        cronJobsScheduleKindFilter: scheduleKind,
      });
    }

    const lastStatusFilter = getElement(
      container,
      '[data-test-id="cron-jobs-last-status-filter"]',
      HTMLSelectElement,
    );
    lastStatusFilter.value = "unknown";
    lastStatusFilter.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onJobsFiltersChange).toHaveBeenCalledWith({ cronJobsLastStatusFilter: "unknown" });

    const triggerFilter = getElement(
      container,
      '[data-test-id="cron-jobs-trigger-filter"]',
      HTMLSelectElement,
    );
    triggerFilter.value = "conditional";
    triggerFilter.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onJobsFiltersChange).toHaveBeenCalledWith({
      cronJobsTriggerFilter: "conditional",
    });

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

  it("does not expose table rows without complete table semantics", () => {
    const container = renderView({ jobs: [createJob("job-1")] });

    for (const row of container.querySelectorAll('[role="row"]')) {
      expect(row.closest('[role="table"], [role="grid"], [role="treegrid"]')).not.toBeNull();
      expect(
        Array.from(row.children).every((child) =>
          child.matches(
            '[role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]',
          ),
        ),
      ).toBe(true);
    }
  });

  it("renders table rows with independent native buttons for opening tasks", () => {
    const onSelectJob = vi.fn();
    const job = createJob("job-1", {
      trigger: { script: "json({ fire: true })" },
      state: { nextRunAtMs: Date.now() + 60_000 },
    });
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
    expect(rows[0]?.getAttribute("role")).toBeNull();
    expect(rows[0]?.textContent).toContain("Cron 0 9 * * *");
    expect(rows[1]?.classList.contains("cron-table__row--paused")).toBe(true);
    expect(rows[1]?.textContent).toContain("Paused");
    expect(rows[2]?.querySelector(".cron-table__state--error")?.getAttribute("aria-label")).toBe(
      "Error",
    );
    expect(rows[2]?.querySelector(".cron-last-glyph--error")).not.toBeNull();
    expect(rows[2]?.querySelector(".cron-table__last-run")?.getAttribute("aria-label")).toBe(
      "Error",
    );
    expect(rows[0]?.querySelector(".cron-last-glyph--ok")).toBeNull();
    expect(rows[0]?.textContent).toContain("n/a");
    expect(rows[0]?.querySelector(".cron-trigger-icon")?.getAttribute("aria-label")).toBe(
      "Trigger configured",
    );

    getElement(rows[1] as Element, ".cron-table__name", HTMLButtonElement).click();
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
      name: "Repo pulse",
    });
    expect(patch).not.toHaveProperty("deliveryMode");
    expect(String(patch.payloadText)).toContain("overnight activity");
  });

  it("offers Create & run now only in create mode", () => {
    const onSubmitRunNow = vi.fn();
    const create = renderView({ createOpen: true, onSubmitRunNow });
    getElement(create, '[data-test-id="cron-submit-run"]', HTMLButtonElement).click();
    expect(onSubmitRunNow).toHaveBeenCalledTimes(1);

    const job = createJob("job-1");
    const editing = renderView({ jobs: [job], editingJob: job });
    expect(editing.querySelector('[data-test-id="cron-submit-run"]')).toBeNull();
  });

  it("shows starter automations only for a loaded empty inventory", () => {
    const findStarterSection = (container: Element) =>
      Array.from(container.querySelectorAll(".settings-section")).find(
        (section) =>
          section.querySelector(".settings-section__heading")?.textContent?.trim() ===
          "Starter automations",
      ) ?? null;

    expect(findStarterSection(renderView({ jobs: [], jobsTotal: 0 }))).not.toBeNull();

    const configuredJobs = [
      createJob("active"),
      createJob("paused", { enabled: false }),
      createJob("failing", { state: { lastRunStatus: "error" } }),
    ];
    for (const job of configuredJobs) {
      expect(findStarterSection(renderView({ jobs: [job], jobsTotal: 1 }))).toBeNull();
    }

    expect(findStarterSection(renderView({ loading: true }))).toBeNull();
    expect(findStarterSection(renderView({ error: "Unable to load automations." }))).toBeNull();
    expect(findStarterSection(renderView({ jobsQuery: "x" }))).toBeNull();
    expect(findStarterSection(renderView({ jobsEnabledFilter: "enabled" }))).toBeNull();
  });

  it("renders a truthful inventory state matrix for the tasks table", () => {
    // Initial pending: polite loading status, not a false completed-empty message.
    const pending = renderView({ loading: true, hasLoaded: false, jobs: [], jobsTotal: 0 });
    const pendingStatus = getElement(pending, '[data-test-id="cron-jobs-loading"]', HTMLDivElement);
    expect(pendingStatus.getAttribute("role")).toBe("status");
    expect(pendingStatus.getAttribute("aria-live")).toBe("polite");
    expect(pendingStatus.textContent).toContain("Loading...");
    expect(pending.textContent).not.toContain("No automations yet");
    expect(getElement(pending, ".cron-table", HTMLDivElement).getAttribute("aria-busy")).toBe(
      "true",
    );

    // Loaded empty: completed empty guidance with no busy state.
    const loadedEmpty = renderView({ loading: false, hasLoaded: true, jobs: [], jobsTotal: 0 });
    expect(loadedEmpty.querySelector('[data-test-id="cron-jobs-loading"]')).toBeNull();
    const empty = getElement(loadedEmpty, ".cron-empty-state", HTMLDivElement);
    expect(empty.textContent).toContain("No automations yet");
    expect(empty.textContent).toContain("Describe what OpenClaw should do");
    expect(
      getElement(loadedEmpty, ".cron-table", HTMLDivElement).getAttribute("aria-busy"),
    ).toBeNull();

    // Filtered empty keeps the matching-copy variant.
    const filtered = renderView({ loading: false, hasLoaded: true, jobs: [], jobsQuery: "zzz" });
    expect(getElement(filtered, ".cron-empty-state", HTMLDivElement).textContent).toContain(
      "No automations match the current filters.",
    );

    // Refresh with retained rows keeps the rows and marks the region busy.
    const refreshing = renderView({
      loading: true,
      hasLoaded: true,
      jobs: [createJob("refresh-me")],
      jobsTotal: 1,
    });
    expect(refreshing.querySelector('[data-test-id="cron-jobs-loading"]')).toBeNull();
    expect(getElement(refreshing, ".cron-table", HTMLDivElement).getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(refreshing.textContent).toContain("Daily ping");

    // Refresh of a loaded-empty inventory keeps the empty message (no false loading copy).
    const refreshingEmpty = renderView({ loading: true, hasLoaded: true, jobs: [], jobsTotal: 0 });
    expect(refreshingEmpty.querySelector('[data-test-id="cron-jobs-loading"]')).toBeNull();
    expect(getElement(refreshingEmpty, ".cron-empty-state", HTMLDivElement).textContent).toContain(
      "No automations yet",
    );

    // A first list failure reports its own error instead of claiming the inventory is empty.
    const failed = renderView({
      loading: false,
      hasLoaded: false,
      jobs: [],
      listError: "Unable to load automations.",
    });
    expect(failed.querySelector(".cron-empty-state")).toBeNull();
    expect(failed.querySelector('[data-test-id="cron-jobs-loading"]')).toBeNull();
    const failedAlert = getElement(failed, ".cron-error-banner", HTMLDivElement);
    expect(failedAlert.getAttribute("role")).toBe("alert");
    expect(failedAlert.textContent).toContain("Unable to load automations.");

    // A non-list failure cannot hide a successfully loaded empty inventory.
    const unrelatedFailure = renderView({
      hasLoaded: true,
      jobs: [],
      error: "Run history unavailable.",
    });
    expect(unrelatedFailure.querySelector(".cron-empty-state")?.textContent).toContain(
      "No automations yet",
    );
    expect(
      unrelatedFailure.querySelector('.cron-error-banner[role="alert"]')?.textContent,
    ).toContain("Run history unavailable.");
  });

  it("shows a scheduler banner only while the scheduler is off", () => {
    const off = renderView({
      status: { enabled: false, triggersEnabled: true, jobs: 2 },
      jobs: [createJob("job-1")],
      jobsTotal: 2,
    });
    const banner = getElement(off, '[data-test-id="cron-scheduler-banner"]', HTMLDivElement);
    expect(banner.textContent).toContain("Scheduler disabled");
    expect(getElement(off, ".cron-stats", HTMLDivElement).textContent).not.toContain("Scheduler");
    const footer = getElement(off, ".cron-table__footer", HTMLDivElement);
    expect(footer.textContent).toContain("1 of 2");

    const on = renderView({ status: { enabled: true, triggersEnabled: true, jobs: 2 } });
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

describe("cron view selects", () => {
  it("shows authoritative form values instead of first options in the create form", () => {
    const container = renderView({ createOpen: true });
    const action = getElement(
      container,
      "wa-select#cron-payload-kind",
      HTMLElement,
    ) as HTMLElement & {
      value: string;
    };
    expect(action.querySelector("wa-option[selected]")?.getAttribute("value")).toBe("agentTurn");
    const runsIn = getElement(
      container,
      "wa-select#cron-session-target",
      HTMLElement,
    ) as HTMLElement & { value: string };
    expect(runsIn.querySelector("wa-option[selected]")?.getAttribute("value")).toBe("isolated");
    const unit = Array.from(
      container.querySelectorAll<HTMLElement & { value: string }>("wa-select"),
    ).find((select) => select.querySelector('[slot="label"]')?.textContent === "Unit");
    expect(unit?.querySelector("wa-option[selected]")?.getAttribute("value")).toBe("minutes");
    // The targetless create form keeps delivery internal until the operator
    // explicitly selects a channel delivery mode.
    const delivery = getElement(
      container,
      "wa-select#cron-delivery-mode",
      HTMLElement,
    ) as HTMLElement & { value: string };
    expect(delivery.querySelector("wa-option[selected]")?.getAttribute("value")).toBe("none");
  });

  it("shows persisted non-first values in jobs filters and runs sort", () => {
    const activity = renderView({ listTab: "activity", runsSortDir: "asc" });
    const sort = getElement(activity, ".cron-run-sort", HTMLButtonElement);
    expect(sort.textContent).toContain("Oldest first");
    expect(
      activity.querySelector('wa-dropdown-item[value="asc"]')?.getAttribute("aria-current"),
    ).toBe("true");
    const tasks = renderView({ jobsLastStatusFilter: "error" });
    const lastStatus = getElement(
      tasks,
      'select[data-test-id="cron-jobs-last-status-filter"]',
      HTMLSelectElement,
    );
    expect(lastStatus.value).toBe("error");
  });
});
