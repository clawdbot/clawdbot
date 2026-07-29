/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderQuickSettings } from "./quick.ts";

type QuickSettingsProps = Parameters<typeof renderQuickSettings>[0];

type QuickControl = HTMLElement & { disabled: boolean };

function expectButtonByText(container: Element, text: string): QuickControl {
  const button = Array.from(container.querySelectorAll<QuickControl>("button, wa-radio")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!(button instanceof HTMLElement)) {
    throw new Error(`Expected button labelled ${text}`);
  }
  return button;
}

function expectRowByTitle(container: Element, text: string): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>(".settings-row")).find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent?.trim() === text,
  );
  if (!(row instanceof HTMLElement)) {
    throw new Error(`Expected quick settings row "${text}"`);
  }
  return row;
}

function createProps(overrides: Partial<QuickSettingsProps> = {}): QuickSettingsProps {
  return {
    locale: "en",
    onLocaleChange: vi.fn(),
    onModelsClick: vi.fn(),
    connected: true,
    ...overrides,
  };
}

describe("renderQuickSettings", () => {
  it("renders the slim general hub", () => {
    const container = document.createElement("div");

    render(renderQuickSettings(createProps()), container);

    expect(container.querySelectorAll(".settings-page")).toHaveLength(1);
    expect(container.querySelector("[id^='settings-general-']")).toBeNull();
    expect(container.querySelectorAll(".settings-section")).toHaveLength(1);
    expect(container.textContent).not.toContain("Connected");
    expect(container.querySelector(".config-host")).toBeNull();
    expect(container.querySelectorAll(".settings-group")).toHaveLength(1);
    expect(container.querySelector(".settings-group .settings-group")).toBeNull();
  });

  it("changes the Control UI language from General settings", () => {
    const onLocaleChange = vi.fn();
    const container = document.createElement("div");

    render(renderQuickSettings(createProps({ locale: "pt-BR", onLocaleChange })), container);

    const row = expectRowByTitle(container, "Language");
    const select = row.querySelector<HTMLElement & { value: string }>("wa-select");
    if (!(select instanceof HTMLElement)) {
      throw new Error("Expected language selector");
    }
    expect(select.getAttribute("value")).toBe("pt-BR");
    Object.defineProperty(select, "value", { configurable: true, value: "en" });
    select.dispatchEvent(new Event("change"));
    expect(onLocaleChange).toHaveBeenCalledWith("en");
  });

  it("drills into the Models page", () => {
    const onModelsClick = vi.fn();
    const container = document.createElement("div");

    render(renderQuickSettings(createProps({ onModelsClick })), container);

    const row = expectRowByTitle(container, "Models");
    expect(row.classList.contains("settings-row--nav")).toBe(true);
    expect(row.textContent).toContain(
      "Default models, behavior, provider access, usage, and cost.",
    );
    row.click();
    expect(onModelsClick).toHaveBeenCalledTimes(1);
  });

  it("hides the restart banner while the config needs no apply", () => {
    const container = document.createElement("div");

    render(renderQuickSettings(createProps()), container);

    expect(container.querySelector(".config-apply-banner")).toBeNull();
    expect(expectButtonByText.bind(null, container, "Save")).toThrow();
    expect(expectButtonByText.bind(null, container, "Apply Now")).toThrow();
  });

  it("renders the restart banner and wires it to apply", () => {
    const onApplyConfig = vi.fn();
    const container = document.createElement("div");

    render(renderQuickSettings(createProps({ configNeedsApply: true, onApplyConfig })), container);

    const banner = container.querySelector(".config-apply-banner");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("Saved to openclaw.json — restart the gateway to apply.");
    const applyButton = expectButtonByText(container, "Restart & apply");
    expect(applyButton.disabled).toBe(false);
    applyButton.click();
    expect(onApplyConfig).toHaveBeenCalledTimes(1);
  });

  it("gates the restart action while a raw draft is pending", () => {
    const container = document.createElement("div");

    // apply() always refuses while a raw draft is unsaved; an enabled button
    // here would be a dead action with a misleading generic failure.
    render(
      renderQuickSettings(createProps({ configNeedsApply: true, configRawDraftPending: true })),
      container,
    );

    expect(expectButtonByText(container, "Restart & apply").disabled).toBe(true);
  });

  it("surfaces the shared autosave status with its recovery actions", () => {
    const container = document.createElement("div");

    render(renderQuickSettings(createProps()), container);
    expect(container.querySelector(".config-toolbar__status")).toBeNull();

    render(renderQuickSettings(createProps({ configAutoSaveStatus: "saved" })), container);
    expect(container.querySelector(".config-toolbar__status")).toBeNull();
    expect(container.textContent).not.toContain("Saved");

    render(renderQuickSettings(createProps({ configAutoSaveStatus: "saving" })), container);
    expect(container.querySelector(".config-toolbar__status")?.textContent?.trim()).toBe("Saving…");

    const onRetrySaveConfig = vi.fn();
    render(
      renderQuickSettings(createProps({ configAutoSaveStatus: "error", onRetrySaveConfig })),
      container,
    );
    expect(container.querySelector(".config-toolbar__status")?.textContent).toContain(
      "Save failed",
    );
    expectButtonByText(container, "Retry").click();
    expect(onRetrySaveConfig).toHaveBeenCalledTimes(1);

    const onDiscardConfig = vi.fn();
    render(
      renderQuickSettings(createProps({ configAutoSaveStatus: "conflict", onDiscardConfig })),
      container,
    );
    expect(container.querySelector(".config-toolbar__status")?.textContent).toContain(
      "Settings changed elsewhere",
    );
    expectButtonByText(container, "Reload").click();
    expect(onDiscardConfig).toHaveBeenCalledTimes(1);
  });

  it("shows a busy restart banner while applying", () => {
    const container = document.createElement("div");

    render(
      renderQuickSettings(createProps({ configNeedsApply: true, configApplying: true })),
      container,
    );

    const banner = container.querySelector(".config-apply-banner");
    expect(banner?.textContent).toContain("Applying…");
    expect(banner?.querySelector("button")?.disabled).toBe(true);

    // Other in-flight config writes gate the action too.
    render(
      renderQuickSettings(createProps({ configNeedsApply: true, configSaving: true })),
      container,
    );
    expect(container.querySelector(".config-apply-banner button")?.hasAttribute("disabled")).toBe(
      true,
    );
    render(
      renderQuickSettings(createProps({ configNeedsApply: true, configAutoSaveStatus: "saving" })),
      container,
    );
    expect(container.querySelector(".config-apply-banner button")?.hasAttribute("disabled")).toBe(
      true,
    );
    render(
      renderQuickSettings(createProps({ configNeedsApply: true, configUpdating: true })),
      container,
    );
    expect(container.querySelector(".config-apply-banner button")?.hasAttribute("disabled")).toBe(
      true,
    );
  });
});
