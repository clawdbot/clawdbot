// Control UI tests cover the Automations (cron) editor pane behavior.
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import {
  createCronViewJob as createJob,
  findToggleByLabel,
  getButtonByText,
  getElement,
  renderCronView as renderView,
  selectSegmented,
} from "./view.test-support.ts";

describe("cron view editor", () => {
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
      form: {
        ...DEFAULT_CRON_FORM,
        scheduleKind: "cron",
        deliveryChannel: "telegram",
        failureAlertMode: "custom",
        failureAlertChannel: "retired-channel",
      },
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

    const channel = getElement(
      container,
      "#cron-failure-alert-channel",
      HTMLElement,
    ) as HTMLElement & {
      value: string;
    };
    const optionValues = Array.from(channel.querySelectorAll("wa-option"), (option) =>
      option.getAttribute("value"),
    );
    expect(optionValues).toContain("retired-channel");
    expect(channel.querySelector('wa-option[value="telegram"] img')).not.toBeNull();
    const telegramOption = channel.querySelector<HTMLElement & { label?: string }>(
      'wa-option[value="telegram"]',
    );
    expect(telegramOption?.label).toBe("Telegram fallback");
    Object.defineProperty(channel, "value", { configurable: true, value: "telegram" });
    channel.dispatchEvent(new Event("change", { bubbles: true }));
    Reflect.deleteProperty(channel, "value");
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
    const onExitKind = onExitContainer.querySelector('[data-test-id="cron-schedule-kind-on-exit"]');
    expect(onExitKind).not.toBeNull();
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
    const unitSelect = Array.from(container.querySelectorAll("wa-select")).find(
      (select) => select.querySelector('[slot="label"]')?.textContent === "Unit",
    );
    expect(unitSelect).toBeInstanceOf(HTMLElement);
    if (!unitSelect) {
      throw new Error("Expected the interval unit picker");
    }
    const values = Array.from(unitSelect.querySelectorAll("wa-option"), (option) =>
      option.getAttribute("value"),
    );
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
    const delivery = getElement(container, "#cron-delivery-mode", HTMLElement);
    const values = Array.from(delivery.querySelectorAll("wa-option"), (option) =>
      option.getAttribute("value"),
    );
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

    const conditional = renderView({
      createOpen: true,
      form: {
        ...DEFAULT_CRON_FORM,
        triggerEnabled: true,
        triggerScript: "json({ fire: true })",
      },
    });
    expect(conditional.querySelector("#cron-trigger-script")).toBeInstanceOf(HTMLTextAreaElement);
    expect(conditional.querySelector(".cron-trigger-summary")?.textContent).toContain(
      "Trigger configured",
    );
  });

  it("waits for scheduler status before presenting trigger capability", () => {
    const pending = renderView({ createOpen: true, status: null });

    expect(findToggleByLabel(pending, "Condition trigger")).toBeNull();
    expect(pending.textContent).not.toContain("disabled by cron.triggers.enabled");
  });

  it("hides trigger authoring when the operator disabled triggers but keeps clear available", () => {
    const onFormChange = vi.fn();
    const status = { enabled: true, triggersEnabled: false, jobs: 0 };
    const disabled = renderView({ createOpen: true, status, onFormChange });
    expect(disabled.querySelector("#cron-trigger-script")).toBeNull();
    expect(disabled.textContent).toContain("disabled by cron.triggers.enabled");

    const configured = renderView({
      createOpen: true,
      status,
      onFormChange,
      form: {
        ...DEFAULT_CRON_FORM,
        triggerEnabled: true,
        triggerScript: "json({ fire: true })",
      },
    });
    getButtonByText(configured, "Clear trigger").click();
    expect(onFormChange).toHaveBeenCalledWith({ triggerEnabled: false });
  });

  it("renders script payloads as highlighted read-only code without exposing script authoring", () => {
    const script = "const result = await agent('check status')";
    const job = createJob("job-script", {
      name: "Status script",
      payload: { kind: "script", script },
    });
    const container = renderView({
      jobs: [job],
      editingJob: job,
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
    expect(findToggleByLabel(container, "Condition trigger")).toBeNull();
    expect(container.textContent).toContain("Script payloads cannot use condition triggers");
  });

  it("keeps an incompatible existing script condition trigger visible and explicitly clearable", () => {
    const onFormChange = vi.fn();
    const job = createJob("job-script-trigger", {
      payload: { kind: "script", script: "json({ state: {} })" },
      trigger: { script: "json({ fire: true })" },
    });
    const container = renderView({
      jobs: [job],
      editingJob: job,
      onFormChange,
      form: {
        ...DEFAULT_CRON_FORM,
        name: job.name,
        payloadKind: "script",
        payloadLocked: true,
        payloadText: "json({ state: {} })",
        triggerEnabled: true,
        triggerScript: "json({ fire: true })",
      },
      fieldErrors: { triggerScript: "cron.errors.triggerScriptPayloadUnsupported" },
      canSubmit: false,
    });

    expect(findToggleByLabel(container, "Condition trigger")).toBeNull();
    expect(container.querySelector("#cron-trigger-script")).toBeNull();
    expect(container.textContent).toContain("Script payloads cannot use condition triggers");
    getButtonByText(container, "Clear trigger").click();
    expect(onFormChange).toHaveBeenCalledWith({ triggerEnabled: false });
  });

  it("attaches the triggered minimum-interval error to the visible recurring interval", () => {
    const container = renderView({
      createOpen: true,
      canSubmit: false,
      form: {
        ...DEFAULT_CRON_FORM,
        everyAmount: "5",
        everyUnit: "seconds",
        triggerEnabled: true,
        triggerScript: "json({ fire: true })",
      },
      fieldErrors: { everyAmount: "cron.errors.triggerIntervalTooShort" },
    });

    const interval = getElement(container, "#cron-every-amount", HTMLInputElement);
    expect(interval.getAttribute("aria-invalid")).toBe("true");
    expect(interval.getAttribute("aria-describedby")).toBe("cron-error-everyAmount");
    expect(container.querySelector("#cron-error-everyAmount")?.textContent).toContain(
      "at least every 30 seconds",
    );
  });

  it("highlights locked command payloads as shell and keeps heartbeat payloads plain", () => {
    const job = createJob("job-command", {
      name: "Backup",
      payload: { kind: "script", script: "" },
    });
    const command = renderView({
      jobs: [job],
      editingJob: job,
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
    expect(findToggleByLabel(command, "Condition trigger")).not.toBeNull();

    const heartbeat = renderView({
      jobs: [job],
      editingJob: job,
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

  it("renders job detail authority independently from the filtered table", () => {
    const onRun = vi.fn();
    const onToggle = vi.fn();
    const onClone = vi.fn();
    const onRemove = vi.fn();
    const onDetailTabChange = vi.fn();
    const job = createJob("job-1", { name: "Nightly digest" });
    const container = renderView({
      jobs: [],
      jobsTotal: 0,
      editingJob: job,
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

    const settingsTab = container.querySelector('[data-test-id="cron-detail-tab-settings"]');
    expect(settingsTab?.getAttribute("aria-selected")).toBe("true");
    container
      .querySelector('[data-test-id="cron-detail-tab-history"]')
      ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    expect(onDetailTabChange).toHaveBeenCalledWith("history");
  });

  it.each(["heartbeat", "skillCollectionReview"] as const)(
    "renders %s jobs as view-and-run only",
    (kind) => {
      const job = createJob(`system-${kind}`, { payload: { kind } });
      const onRun = vi.fn();
      const onToggle = vi.fn();
      const onClone = vi.fn();
      const onRemove = vi.fn();
      const list = renderView({ jobs: [job], onRun, onToggle, onClone, onRemove });

      getElement(list, `[data-test-id="cron-row-run-${job.id}"]`, HTMLButtonElement).click();
      expect(onRun).toHaveBeenCalledWith(job, "force");
      expect(list.querySelector(`[data-test-id="cron-row-toggle-${job.id}"]`)).toBeNull();
      const listMenu = getElement(list, "wa-dropdown.cron-job-menu", HTMLElement);
      expect(listMenu.querySelector('wa-dropdown-item[value="run-if-due"]')).not.toBeNull();
      expect(listMenu.querySelector('wa-dropdown-item[value="clone"]')).toBeNull();
      expect(listMenu.querySelector('wa-dropdown-item[value="remove"]')).toBeNull();

      const detail = renderView({
        editingJob: job,
        form: {
          ...DEFAULT_CRON_FORM,
          payloadKind: kind,
          payloadLocked: true,
        },
        onRun,
        onToggle,
        onClone,
        onRemove,
      });

      expect(getElement(detail, ".cron-editor", HTMLFieldSetElement).disabled).toBe(true);
      expect(detail.querySelector('[data-test-id="cron-submit"]')).toBeNull();
      expect(detail.querySelector('[data-test-id="cron-toggle-enabled"]')).toBeNull();
      getElement(detail, '[data-test-id="cron-run-now"]', HTMLButtonElement).click();
      expect(onRun).toHaveBeenLastCalledWith(job, "force");
      const detailMenu = getElement(detail, "wa-dropdown.cron-job-menu", HTMLElement);
      const runIfDue = getElement(detailMenu, 'wa-dropdown-item[value="run-if-due"]', HTMLElement);
      detailMenu.dispatchEvent(
        new CustomEvent("wa-select", { detail: { item: runIfDue }, bubbles: true }),
      );
      expect(onRun).toHaveBeenLastCalledWith(job, "due");
      expect(detailMenu.querySelector('wa-dropdown-item[value="clone"]')).toBeNull();
      expect(detailMenu.querySelector('wa-dropdown-item[value="remove"]')).toBeNull();
      expect(onToggle).not.toHaveBeenCalled();
      expect(onClone).not.toHaveBeenCalled();
      expect(onRemove).not.toHaveBeenCalled();
    },
  );

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

    const detail = renderView({
      canManage: false,
      jobs: [],
      editingJob: job,
    });
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
    const container = renderView({ jobs: [job], editingJob: job, busy: true });

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
      editingJob: job,
      detailTab: "history",
      runs: [
        {
          ts: 5,
          jobId: "job-1",
          action: "finished",
          jobName: "Nightly digest",
          status: "ok",
          summary: "ran",
        },
      ],
    });
    expect(container.querySelector(".cron-run-entry")).not.toBeNull();
    expect(container.querySelector(".cron-editor")).toBeNull();
    const description = container.querySelector('[data-test-id="cron-detail-description"]');
    expect(description?.textContent).toContain(job.description);
  });

  it("shows the paused switch state for disabled jobs", () => {
    const onToggle = vi.fn();
    const job = createJob("job-1", { enabled: false });
    const container = renderView({
      jobs: [],
      editingJob: job,
      onToggle,
    });
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

  it("renders model-picker suggestions with the remaining text datalists", () => {
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
      "cron-thinking-suggestions",
      "cron-tz-suggestions",
      "cron-delivery-to-suggestions",
      "cron-delivery-account-suggestions",
    ]) {
      expect(container.querySelector(`datalist#${id}`)).not.toBeNull();
    }
    const model = getElement(container, "#cron-payload-model-picker", HTMLElement);
    expect(model.querySelector('wa-option[value="openai/gpt-5.2"]')).not.toBeNull();
    expect(model.querySelector('[data-provider-icon="codex"]')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>("#cron-payload-model")?.hidden).toBe(true);
    // The inherit option must resolve to a real catalog string — a missing key
    // renders the raw "common.default" literal to every locale.
    const inheritText = model.querySelector('wa-option[value=""]')?.textContent ?? "";
    expect(inheritText).toContain("Default");
    expect(inheritText).not.toContain("common.default");
  });
});
