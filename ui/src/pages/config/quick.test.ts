/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderQuickSettings } from "./quick.ts";

type QuickSettingsProps = Parameters<typeof renderQuickSettings>[0];

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
    const intro = container.querySelector(".settings-page__intro");
    expect(intro?.textContent).toContain("Settings sync to your Gateway configuration file.");
    expect(intro?.querySelector<HTMLAnchorElement>("a")?.href).toBe(
      "https://docs.openclaw.ai/gateway/configuration",
    );
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
});
