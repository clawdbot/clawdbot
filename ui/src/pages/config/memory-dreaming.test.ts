/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderDreamingSettings } from "./memory-dreaming.ts";

function renderInto(
  dreaming: Record<string, unknown> | null,
  onPatch: (path: readonly string[], value: unknown) => void = vi.fn(),
  disabled = false,
): HTMLElement {
  const container = document.createElement("div");
  render(
    renderDreamingSettings({ dreaming, timezoneDefault: "Asia/Singapore", disabled, onPatch }),
    container,
  );
  return container;
}

function numberInput(container: HTMLElement, label: string): HTMLInputElement {
  const input = [...container.querySelectorAll<HTMLInputElement>("input.settings-input")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  if (!input) {
    throw new Error(`no input labelled ${label}`);
  }
  return input;
}

function editNumber(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("change"));
}

function rowFor(container: HTMLElement, title: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>(".settings-row")].find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent?.trim() === title,
  );
  if (!row) {
    throw new Error(`no row titled ${title}`);
  }
  return row;
}

/** Toggle state keyed by "<section heading>/<row title>"; `checked` is a property binding. */
function toggleStates(container: HTMLElement): Record<string, boolean> {
  const states: Record<string, boolean> = {};
  for (const row of container.querySelectorAll(".settings-row--toggle")) {
    const title = row.querySelector(".settings-row__title")?.textContent?.trim() ?? "";
    const section = row.closest(".settings-section")?.querySelector(".settings-section__heading");
    const key = `${section?.textContent?.trim() ?? ""}/${title}`;
    const toggle = row.querySelector<HTMLElement & { checked?: boolean }>("wa-switch");
    states[key] = toggle?.checked === true;
  }
  return states;
}

function selectedSegment(container: HTMLElement): string | null {
  return (
    container.querySelector("wa-radio.settings-segmented__btn--active")?.getAttribute("value") ??
    null
  );
}

describe("renderDreamingSettings", () => {
  // resolveMemoryDreamingConfig defaults every phase's `enabled` to true, so a
  // config that only turns dreaming on is running all three phases.
  it("renders every phase as on when the config only sets dreaming.enabled", () => {
    const states = toggleStates(renderInto({ enabled: true }));

    expect(states["Light phase/Enabled"]).toBe(true);
    expect(states["Deep phase/Enabled"]).toBe(true);
    expect(states["REM phase/Enabled"]).toBe(true);
  });

  it("still renders a phase that config explicitly disables as off", () => {
    const states = toggleStates(
      renderInto({ enabled: true, phases: { deep: { enabled: false } } }),
    );

    expect(states["Light phase/Enabled"]).toBe(true);
    expect(states["Deep phase/Enabled"]).toBe(false);
  });

  it("keeps toggles that default to off unchecked when absent", () => {
    const states = toggleStates(renderInto(null));

    expect(states["Schedule/Verbose logging"]).toBe(false);
    expect(states["Storage/Separate reports"]).toBe(false);
  });

  it("renders the runtime storage-mode default when the config omits it", () => {
    expect(selectedSegment(renderInto({ enabled: true }))).toBe("separate");
    expect(selectedSegment(renderInto({ storage: { mode: "inline" } }))).toBe("inline");
    expect(selectedSegment(renderInto({ storage: { mode: "both" } }))).toBe("both");
    // An unreadable stored value is not a fourth mode: it reads as the default.
    expect(selectedSegment(renderInto({ storage: { mode: "nonsense" } }))).toBe("separate");
  });

  it("shows inherited values and dynamic timezone provenance", () => {
    const container = renderInto(null);

    expect(rowFor(container, "Dreaming frequency").textContent).toContain(
      "Using default: 0 3 * * *",
    );
    expect(rowFor(container, "Timezone").textContent).toContain("Using default: Asia/Singapore");
    expect(numberInput(container, "Lookback days").placeholder).toBe("2");
    expect(rowFor(container, "Lookback days").textContent).toContain("Using default: 2");
    expect(container.querySelector('button[aria-label="Reset to default"]')).toBeNull();
  });

  it("shows the advanced execution model as the inherited model default", () => {
    const onPatch = vi.fn();
    const container = renderInto(
      {
        model: "anthropic/claude-sonnet",
        execution: { defaults: { model: "openai/gpt-5.6" } },
      },
      onPatch,
    );
    const row = rowFor(container, "Dreaming model");

    expect(row.textContent).toContain("Default: openai/gpt-5.6");
    expect(row.querySelector('wa-option[value="anthropic/claude-sonnet"]')).not.toBeNull();
    const custom = row.querySelector<HTMLInputElement>(".model-picker__custom");
    expect(custom?.hidden).toBe(false);
    if (custom) {
      custom.value = "vendor/model with spaces";
      custom.dispatchEvent(new Event("change", { bubbles: true }));
    }
    expect(onPatch).toHaveBeenCalledWith(["model"], "vendor/model with spaces");
    row.querySelector<HTMLButtonElement>('button[aria-label="Reset to default"]')?.click();
    expect(onPatch).toHaveBeenCalledWith(["model"], undefined);

    const inherited = renderInto({ execution: { defaults: { model: "openai/gpt-5.6" } } });
    expect(rowFor(inherited, "Dreaming model").textContent).toContain(
      "Using default: openai/gpt-5.6",
    );
  });

  it("resets explicit dreaming values by removing their owning config keys", () => {
    const onPatch = vi.fn();
    const container = renderInto(
      {
        frequency: "0 6 * * *",
        verboseLogging: true,
        storage: { mode: "both" },
        phases: { light: { lookbackDays: 5 } },
      },
      onPatch,
    );

    for (const title of [
      "Dreaming frequency",
      "Verbose logging",
      "Storage mode",
      "Lookback days",
    ]) {
      rowFor(container, title)
        .querySelector<HTMLButtonElement>('button[aria-label="Reset to default"]')
        ?.click();
    }

    expect(onPatch).toHaveBeenCalledWith(["frequency"], undefined);
    expect(onPatch).toHaveBeenCalledWith(["verboseLogging"], undefined);
    expect(onPatch).toHaveBeenCalledWith(["storage", "mode"], undefined);
    expect(onPatch).toHaveBeenCalledWith(["phases", "light", "lookbackDays"], undefined);
  });

  it("keeps malformed explicit values resettable while displaying runtime defaults", () => {
    const onPatch = vi.fn();
    const container = renderInto(
      {
        frequency: 42,
        verboseLogging: "yes",
        storage: { mode: 42, separateReports: "yes" },
      },
      onPatch,
    );

    for (const title of [
      "Dreaming frequency",
      "Verbose logging",
      "Storage mode",
      "Separate reports",
    ]) {
      const row = rowFor(container, title);
      expect(row.textContent).toContain("Default:");
      row.querySelector<HTMLButtonElement>('button[aria-label="Reset to default"]')?.click();
    }
    expect(numberInput(container, "Dreaming frequency").value).toBe("");
    expect(toggleStates(container)["Schedule/Verbose logging"]).toBe(false);
    expect(selectedSegment(container)).toBe("separate");
    expect(toggleStates(container)["Storage/Separate reports"]).toBe(false);
    expect(onPatch).toHaveBeenCalledWith(["frequency"], undefined);
    expect(onPatch).toHaveBeenCalledWith(["verboseLogging"], undefined);
    expect(onPatch).toHaveBeenCalledWith(["storage", "mode"], undefined);
    expect(onPatch).toHaveBeenCalledWith(["storage", "separateReports"], undefined);
  });

  it("locks every global dreaming control when config mutation is unavailable", () => {
    const container = renderInto(null, vi.fn(), true);

    expect(
      [...container.querySelectorAll<HTMLInputElement>("input")].every((input) => input.disabled),
    ).toBe(true);
    expect(
      [...container.querySelectorAll<HTMLElement & { disabled?: boolean }>("wa-switch")].every(
        (toggle) => toggle.disabled === true,
      ),
    ).toBe(true);
    expect(
      container.querySelector<HTMLElement & { disabled?: boolean }>("wa-radio-group")?.disabled,
    ).toBe(true);
  });
});

describe("numeric field bounds", () => {
  // extensions/memory-core/openclaw.plugin.json: counts are integers with a
  // minimum, similarity/score fields are numbers in 0..1.
  it("rejects values the memory-core manifest would refuse instead of patching them", () => {
    const onPatch = vi.fn();
    const container = renderInto({ enabled: true }, onPatch);

    editNumber(numberInput(container, "Lookback days"), "-1");
    editNumber(numberInput(container, "Limit"), "2.5");
    editNumber(numberInput(container, "Dedupe similarity"), "1.4");
    editNumber(numberInput(container, "Maximum age (days)"), "0");
    expect(onPatch).not.toHaveBeenCalled();

    editNumber(numberInput(container, "Lookback days"), "7");
    editNumber(numberInput(container, "Dedupe similarity"), "0.82");
    expect(onPatch).toHaveBeenNthCalledWith(1, ["phases", "light", "lookbackDays"], 7);
    expect(onPatch).toHaveBeenNthCalledWith(2, ["phases", "light", "dedupeSimilarity"], 0.82);
  });

  it("restores the stored value so a refused edit does not linger in the field", () => {
    const container = renderInto({ phases: { light: { lookbackDays: 7 } } });
    const input = numberInput(container, "Lookback days");

    editNumber(input, "-3");
    expect(input.value).toBe("7");
  });

  it("treats the manifest bounds as inclusive", () => {
    const onPatch = vi.fn();
    const container = renderInto({ enabled: true }, onPatch);

    editNumber(numberInput(container, "Dedupe similarity"), "1");
    editNumber(numberInput(container, "Dedupe similarity"), "0");
    expect(onPatch).toHaveBeenNthCalledWith(1, ["phases", "light", "dedupeSimilarity"], 1);
    expect(onPatch).toHaveBeenNthCalledWith(2, ["phases", "light", "dedupeSimilarity"], 0);
  });

  it("clears the stored value when the field is emptied", () => {
    const onPatch = vi.fn();
    const container = renderInto({ phases: { light: { lookbackDays: 7 } } }, onPatch);

    editNumber(numberInput(container, "Lookback days"), "");
    expect(onPatch).toHaveBeenCalledWith(["phases", "light", "lookbackDays"], undefined);
  });

  it("advertises the manifest bounds on the inputs", () => {
    const container = renderInto(null);

    const similarity = numberInput(container, "Dedupe similarity");
    expect(similarity.getAttribute("min")).toBe("0");
    expect(similarity.getAttribute("max")).toBe("1");
    expect(similarity.getAttribute("step")).toBe("any");

    const maxAge = numberInput(container, "Maximum age (days)");
    expect(maxAge.getAttribute("min")).toBe("1");
    expect(maxAge.getAttribute("step")).toBe("1");
    expect(maxAge.getAttribute("max")).toBeNull();
  });
});
