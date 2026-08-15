/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readBrowserLinkPreference,
  writeBrowserLinkPreference,
} from "../../components/browser/browser-link-preference.ts";
import { renderBrowserLinkPreferencesRow } from "./browser-link-preferences.ts";

describe("Control UI browser link preferences row", () => {
  afterEach(() => writeBrowserLinkPreference(false));

  it("persists an explicit browser-local opt-in and defaults off", () => {
    expect(readBrowserLinkPreference()).toBe(false);
    writeBrowserLinkPreference(true);
    expect(readBrowserLinkPreference()).toBe(true);
    writeBrowserLinkPreference(false);
    expect(readBrowserLinkPreference()).toBe(false);
  });

  it("renders an accessible default-off toggle and publishes changes", () => {
    const onChange = vi.fn();
    const container = document.createElement("div");

    render(
      renderBrowserLinkPreferencesRow({
        enabled: false,
        onChange,
      }),
      container,
    );

    expect(container.querySelector(".settings-row__title")?.textContent?.trim()).toBe(
      "Open links in Control UI browser",
    );
    const toggle = container.querySelector<HTMLElement & { checked: boolean }>("wa-switch");
    expect(toggle?.checked).toBe(false);
    expect(toggle?.textContent?.trim()).toBe("Open links in Control UI browser");

    if (!toggle) {
      throw new Error("missing Control UI browser link preference toggle");
    }
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
