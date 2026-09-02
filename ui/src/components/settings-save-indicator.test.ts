/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import type { SettingsSaveIndicatorProps } from "./settings-save-indicator.ts";
import "./settings-save-indicator.ts";

type SettingsSaveIndicatorElement = HTMLElement & {
  props?: SettingsSaveIndicatorProps;
  updateComplete: Promise<boolean>;
};

let indicator: SettingsSaveIndicatorElement;

function props(overrides: Partial<SettingsSaveIndicatorProps> = {}): SettingsSaveIndicatorProps {
  return {
    status: "idle",
    lastError: null,
    needsApply: false,
    applying: false,
    applyDisabled: false,
    onRetry: vi.fn(),
    onReload: vi.fn(),
    onApply: vi.fn(),
    ...overrides,
  };
}

async function update(next: SettingsSaveIndicatorProps): Promise<void> {
  indicator.props = next;
  await indicator.updateComplete;
}

function button(label: string): HTMLButtonElement | undefined {
  return [...indicator.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

beforeEach(async () => {
  await i18n.setLocale("en");
  indicator = document.createElement(
    "openclaw-settings-save-indicator",
  ) as SettingsSaveIndicatorElement;
  document.body.append(indicator);
});

afterEach(() => {
  indicator.remove();
  vi.useRealTimers();
});

describe("settings save indicator", () => {
  it("stays empty while idle", async () => {
    await update(props());

    expect(indicator.textContent?.trim()).toBe("");
    expect(indicator.querySelector('[role="status"]')).toBeNull();
  });

  it("renders the shared working claw while saving", async () => {
    await update(props({ status: "saving" }));

    expect(indicator.textContent?.trim()).toBe("Saving…");
    expect(indicator.querySelector(".settings-save-indicator__claw--saving svg")).not.toBeNull();
    expect(
      indicator.querySelector(".settings-save-indicator__claw")?.getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("shows saved for two seconds after saving, then returns to apply", async () => {
    vi.useFakeTimers();
    await update(props({ status: "saving" }));
    await update(props({ status: "saved", needsApply: true }));

    expect(indicator.textContent).toContain("Saved");
    expect(indicator.querySelector(".settings-save-indicator__claw--saved")).not.toBeNull();
    expect(indicator.querySelector(".settings-save-indicator__check")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1_999);
    expect(indicator.textContent).toContain("Saved");
    await vi.advanceTimersByTimeAsync(1);
    await indicator.updateComplete;
    expect(indicator.textContent?.trim()).toBe("Apply changes");
  });

  it("surfaces save errors and retries with the original message", async () => {
    const onRetry = vi.fn();
    await update(props({ status: "error", lastError: "permission denied", onRetry }));

    const status = indicator.querySelector('[role="status"]');
    expect(status?.textContent).toContain("Save failed");
    expect(status?.getAttribute("title")).toBe("permission denied");
    expect(status?.getAttribute("aria-label")).toBe("Save failed: permission denied");
    button("Retry")?.click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("reloads on conflicts instead of offering retry", async () => {
    const onReload = vi.fn();
    await update(props({ status: "conflict", onReload }));

    expect(indicator.textContent).toContain("Settings changed elsewhere");
    expect(button("Retry")).toBeUndefined();
    button("Reload")?.click();
    expect(onReload).toHaveBeenCalledOnce();
  });

  it("applies pending changes and reports the in-flight state", async () => {
    const onApply = vi.fn();
    await update(props({ needsApply: true, onApply }));

    button("Apply changes")?.click();
    expect(onApply).toHaveBeenCalledOnce();

    await update(props({ needsApply: true, applying: true, onApply }));
    expect(indicator.textContent?.trim()).toBe("Applying…");
    expect(indicator.querySelector(".settings-save-indicator__spinner")).not.toBeNull();
    expect(button("Apply changes")).toBeUndefined();
  });

  it("cleans the saved timer when disconnected", async () => {
    vi.useFakeTimers();
    await update(props({ status: "saving" }));
    expect(vi.getTimerCount()).toBe(0);
    await update(props({ status: "saved" }));
    expect(vi.getTimerCount()).toBe(1);

    indicator.remove();

    expect(vi.getTimerCount()).toBe(0);
  });
});
