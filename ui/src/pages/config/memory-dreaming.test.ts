/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  normalizeStorageMode,
  parseDreamingNumber,
  renderDreamingSettings,
} from "./memory-dreaming.ts";

function renderInto(
  dreaming: Record<string, unknown> | null,
  onPatch: (path: readonly string[], value: unknown) => void = vi.fn(),
): HTMLElement {
  const container = document.createElement("div");
  render(renderDreamingSettings({ dreaming, onPatch }), container);
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

describe("parseDreamingNumber", () => {
  it("enforces integer, minimum, and maximum from the manifest", () => {
    expect(parseDreamingNumber("0", { integer: true, min: 0 })).toBe(0);
    expect(parseDreamingNumber("-1", { integer: true, min: 0 })).toBeNull();
    expect(parseDreamingNumber("1.5", { integer: true, min: 0 })).toBeNull();
    expect(parseDreamingNumber("nope", { integer: true, min: 0 })).toBeNull();
    expect(parseDreamingNumber("1", { integer: false, min: 0, max: 1 })).toBe(1);
    expect(parseDreamingNumber("1.01", { integer: false, min: 0, max: 1 })).toBeNull();
  });
});

describe("normalizeStorageMode", () => {
  it("falls back to DEFAULT_MEMORY_DREAMING_STORAGE_MODE, not inline", () => {
    expect(normalizeStorageMode(undefined)).toBe("separate");
    expect(normalizeStorageMode("nonsense")).toBe("separate");
    expect(normalizeStorageMode("inline")).toBe("inline");
    expect(normalizeStorageMode("both")).toBe("both");
  });
});
