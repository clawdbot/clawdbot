/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderSecurity } from "./security.ts";

type SecurityViewProps = Parameters<typeof renderSecurity>[0];

type SecurityControl = HTMLElement & { checked?: boolean; disabled: boolean };

function expectButtonByText(container: Element, text: string): SecurityControl {
  const button = Array.from(container.querySelectorAll<SecurityControl>("button, wa-radio")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!(button instanceof HTMLElement)) {
    throw new Error(`Expected button labelled ${text}`);
  }
  return button;
}

function selectRadio(control: SecurityControl) {
  if (control.checked) {
    return;
  }
  const group = control.closest<HTMLElement & { value: string }>("wa-radio-group");
  expect(group).not.toBeNull();
  if (!group) {
    return;
  }
  group.value = control.getAttribute("value") ?? "";
  group.dispatchEvent(new Event("change", { bubbles: true }));
}

function expectRowByTitle(container: Element, text: string): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>(".settings-row")).find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent?.trim() === text,
  );
  if (!(row instanceof HTMLElement)) {
    throw new Error(`Expected security row "${text}"`);
  }
  return row;
}

function createProps(overrides: Partial<SecurityViewProps> = {}): SecurityViewProps {
  return {
    security: {
      gatewayAuth: "token",
      execPolicy: "allowlist",
      deviceAuth: true,
      browserEnabled: true,
      toolProfile: "coding",
    },
    configBusy: false,
    canPairDevice: true,
    onPairMobile: vi.fn(),
    onBrowserEnabledToggle: vi.fn(),
    onToolProfileChange: vi.fn(),
    editor: html``,
    ...overrides,
  };
}

describe("renderSecurity", () => {
  it("lets operators change browser and tool profile from the overview", () => {
    const onBrowserEnabledToggle = vi.fn();
    const onToolProfileChange = vi.fn();
    const container = document.createElement("div");

    render(
      renderSecurity(
        createProps({
          security: {
            gatewayAuth: "token",
            execPolicy: "allowlist",
            deviceAuth: true,
            browserEnabled: false,
            toolProfile: "messaging",
          },
          onBrowserEnabledToggle,
          onToolProfileChange,
        }),
      ),
      container,
    );

    const browserRow = expectRowByTitle(container, "Browser enabled");
    const browserInput = browserRow.querySelector<HTMLElement & { checked: boolean }>("wa-switch");
    expect(browserInput).toBeInstanceOf(HTMLElement);
    expect(browserInput?.checked).toBe(false);
    if (!browserInput) {
      throw new Error("Expected browser switch");
    }
    browserInput.checked = true;
    browserInput.dispatchEvent(new Event("change"));
    expect(onBrowserEnabledToggle).toHaveBeenCalledWith(true);

    selectRadio(expectButtonByText(container, "Full"));
    expect(onToolProfileChange).toHaveBeenCalledWith("full");
    const activeProfile = expectButtonByText(container, "Messaging");
    expect(activeProfile.classList.contains("settings-segmented__btn--active")).toBe(true);
  });

  it("locks config-backed controls while a config operation is pending", () => {
    const onToolProfileChange = vi.fn();
    const container = document.createElement("div");

    render(renderSecurity(createProps({ configBusy: true, onToolProfileChange })), container);

    const profileButton = expectButtonByText(expectRowByTitle(container, "Tool profile"), "Full");
    expect(
      (profileButton.closest("wa-radio-group") as HTMLElement & { disabled?: boolean }).disabled,
    ).toBe(true);
    profileButton.click();
    expect(onToolProfileChange).not.toHaveBeenCalled();
    const browserRow = expectRowByTitle(container, "Browser enabled");
    expect(browserRow.querySelector("wa-switch")?.hasAttribute("disabled")).toBe(true);
  });

  it("shows gateway auth and device auth as dot statuses, not pills", () => {
    const container = document.createElement("div");

    render(
      renderSecurity(
        createProps({
          security: {
            gatewayAuth: "none",
            execPolicy: "allowlist",
            deviceAuth: true,
            browserEnabled: true,
            toolProfile: "full",
          },
        }),
      ),
      container,
    );

    const authRow = expectRowByTitle(container, "Gateway auth");
    const authStatus = authRow.querySelector(".settings-status");
    expect(authStatus?.textContent?.trim()).toBe("none");
    expect(authStatus?.classList.contains("settings-status--warn")).toBe(true);
    const deviceRow = expectRowByTitle(container, "Device auth");
    expect(deviceRow.querySelector(".settings-status--ok")?.textContent?.trim()).toBe("Enabled");
  });

  it("opens mobile pairing from the overview", () => {
    const onPairMobile = vi.fn();
    const container = document.createElement("div");

    render(renderSecurity(createProps({ onPairMobile })), container);

    expectRowByTitle(container, "OpenClaw mobile");
    const button = expectButtonByText(container, "Pair mobile device");
    expect(button.disabled).toBe(false);
    button.click();
    expect(onPairMobile).toHaveBeenCalledOnce();
  });

  it("embeds the schema editor below the curated overview", () => {
    const container = document.createElement("div");

    render(
      renderSecurity(createProps({ editor: html`<div data-testid="security-editor"></div>` })),
      container,
    );

    const page = container.querySelector(".security-page");
    expect(page).not.toBeNull();
    expect(page?.querySelector("[data-testid='security-editor']")).not.toBeNull();
  });
});
