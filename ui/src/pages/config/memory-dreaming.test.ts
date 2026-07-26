/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { normalizeStorageMode, renderDreamingSettings } from "./memory-dreaming.ts";

function renderInto(dreaming: Record<string, unknown> | null): HTMLElement {
  const container = document.createElement("div");
  render(renderDreamingSettings({ dreaming, onPatch: vi.fn() }), container);
  return container;
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

describe("normalizeStorageMode", () => {
  it("falls back to DEFAULT_MEMORY_DREAMING_STORAGE_MODE, not inline", () => {
    expect(normalizeStorageMode(undefined)).toBe("separate");
    expect(normalizeStorageMode("nonsense")).toBe("separate");
    expect(normalizeStorageMode("inline")).toBe("inline");
    expect(normalizeStorageMode("both")).toBe("both");
  });
});
