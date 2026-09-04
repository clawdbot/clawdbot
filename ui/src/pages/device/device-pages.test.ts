/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import type {
  NativeDeviceSettingsCapability,
  NativeDeviceSettingsSnapshot,
} from "../../app/native-device-settings.ts";
import { i18n } from "../../i18n/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createNativeDeviceSettingsSnapshot } from "../../test-helpers/native-device-settings.ts";
import "./device-page.ts";
import "./permissions-page.ts";

type DevicePageElement = HTMLElement & { updateComplete: Promise<boolean> };
type ToggleElement = HTMLElement & { checked: boolean; disabled: boolean };

function createCapability(
  snapshot: NativeDeviceSettingsSnapshot | null = createNativeDeviceSettingsSnapshot(),
) {
  const listeners = new Set<(value: NativeDeviceSettingsSnapshot) => void>();
  const capability = {
    snapshot,
    subscribe(listener: (value: NativeDeviceSettingsSnapshot) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: vi.fn(),
    requestPermission: vi.fn(),
    openSystemSettings: vi.fn(),
    openPanel: vi.fn(),
    checkForUpdates: vi.fn(),
    refresh: vi.fn(),
    dispose: vi.fn(),
  } satisfies NativeDeviceSettingsCapability;
  return {
    capability,
    publish(next: NativeDeviceSettingsSnapshot) {
      capability.snapshot = next;
      listeners.forEach((listener) => listener(next));
    },
  };
}

async function mount(
  tag: "openclaw-device-page" | "openclaw-device-permissions-page",
  nativeDeviceSettings: NativeDeviceSettingsCapability | null,
) {
  const provider = createApplicationContextProvider({ nativeDeviceSettings } as ApplicationContext);
  const page = document.createElement(tag) as DevicePageElement;
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return page;
}

function row(page: HTMLElement, title: string): HTMLElement {
  const match = [...page.querySelectorAll<HTMLElement>(".settings-row")].find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent?.trim() === title,
  );
  if (!match) {
    throw new Error(`Missing row: ${title}`);
  }
  return match;
}

function toggle(page: HTMLElement, title: string, checked: boolean) {
  const element = row(page, title).querySelector<ToggleElement>("wa-switch")!;
  element.checked = checked;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(async () => {
  await i18n.setLocale("en");
});
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("native device settings pages", () => {
  it.each(["openclaw-device-page", "openclaw-device-permissions-page"] as const)(
    "shows an app-only state without a bridge and waits for the initial snapshot on %s",
    async (tag) => {
      const browserPage = await mount(tag, null);
      expect(browserPage.textContent).toContain("only available inside the OpenClaw Mac app");
      expect(browserPage.querySelector("wa-switch")).toBeNull();
      const { capability } = createCapability(null);
      const waitingPage = await mount(tag, capability);
      expect(waitingPage.textContent).toContain("Waiting for settings from the Mac app");
      expect(waitingPage.querySelector("wa-switch")).toBeNull();
    },
  );

  it("renders local settings and delegates native toggles and panels without Gateway access", async () => {
    const snapshot = createNativeDeviceSettingsSnapshot();
    snapshot.app.debugPaneEnabled = true;
    snapshot.app.quickChatShortcut = null;
    snapshot.app.launchAtLoginAvailable = false;
    const { capability } = createCapability(snapshot);
    const page = await mount("openclaw-device-page", capability);
    expect(page.querySelector(".page-title")?.textContent).toContain("This Mac");
    expect(page.querySelector<HTMLAnchorElement>(".page-subtitle a")?.href).toBe(
      "https://docs.openclaw.ai/platforms/macos",
    );
    expect(row(page, "Quick Chat shortcut").textContent).toContain("Not set");
    expect(row(page, "Launch at login").querySelector<ToggleElement>("wa-switch")!.disabled).toBe(
      true,
    );
    expect(row(page, "Launch at login").textContent).toContain("requires a bundled app");
    expect(
      row(page, "Computer Control provider").querySelector<HTMLOptionElement>(
        'option[value="cua"]',
      )!.disabled,
    ).toBe(true);
    expect(row(page, "Allow Computer Control").textContent).toContain(
      "without per-action confirmation. High risk.",
    );

    toggle(page, "Show Dock icon", false);
    expect(capability.set).toHaveBeenCalledWith("app.showDockIcon", false);
    for (const [title, panel] of [
      ["Quick Chat shortcut", "quick-chat-shortcut"],
      ["Browser logins", "browser-import"],
      ["Debug window", "debug"],
    ] as const) {
      row(page, title).querySelector<HTMLButtonElement>("button")!.click();
      expect(capability.openPanel).toHaveBeenCalledWith(panel);
    }
  });

  it("renders new native snapshots and removes controls whose native capabilities became unavailable", async () => {
    const native = createCapability();
    const page = await mount("openclaw-device-page", native.capability);
    const next = createNativeDeviceSettingsSnapshot();
    next.app.quickChatShortcut = "⌘K";
    next.app.showDockIcon = false;
    next.capabilities.computerControlEnabled = false;
    next.browser.importAvailable = false;
    next.browser.cookieSync.available = false;
    native.publish(next);
    await page.updateComplete;
    expect(row(page, "Quick Chat shortcut").textContent).toContain("⌘K");
    expect(row(page, "Show Dock icon").querySelector<ToggleElement>("wa-switch")!.checked).toBe(
      false,
    );
    expect(
      row(page, "Enable Peekaboo Bridge").querySelector<ToggleElement>("wa-switch")!.disabled,
    ).toBe(true);
    expect(page.querySelector('[aria-label="Computer Control provider"]')).toBeNull();
    expect(page.textContent).not.toContain("Import browser logins…");
    expect(page.querySelector('[aria-label="Target profile"]')).toBeNull();
    expect(page.textContent).toContain("Cookie sync requires remote mode");
    expect(page.textContent).not.toContain("Open Debug window…");
  });

  it("normalizes and deduplicates added cookie hostnames and removes a selected hostname", async () => {
    const { capability } = createCapability();
    const page = await mount("openclaw-device-page", capability);
    const input = row(page, "Domains").querySelector<HTMLInputElement>("input")!;
    const form = row(page, "Domains").querySelector<HTMLFormElement>("form")!;
    for (const hostname of ["  EXAMPLE.COM ", "  ACCOUNTS.EXAMPLE.ORG  "]) {
      input.value = hostname;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await page.updateComplete;
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await page.updateComplete;
    }
    expect(capability.set).toHaveBeenLastCalledWith("browser.cookieSync.domains", [
      "example.com",
      "accounts.example.org",
    ]);
    page.querySelector<HTMLButtonElement>('[aria-label="Remove example.com"]')?.click();
    expect(capability.set).toHaveBeenLastCalledWith("browser.cookieSync.domains", [
      "accounts.example.org",
    ]);
  });

  it("preserves newer domain edits across an older native acknowledgement", async () => {
    const native = createCapability();
    const page = await mount("openclaw-device-page", native.capability);
    for (const hostname of ["a.example.com", "b.example.com"]) {
      const input = row(page, "Domains").querySelector<HTMLInputElement>("input")!;
      input.value = hostname;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await page.updateComplete;
      row(page, "Domains")
        .querySelector<HTMLFormElement>("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await page.updateComplete;
    }

    const older = createNativeDeviceSettingsSnapshot();
    older.browser.cookieSync.domains = ["example.com", "a.example.com"];
    native.publish(older);
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>('[aria-label="Remove example.com"]')?.click();
    expect(native.capability.set).toHaveBeenLastCalledWith("browser.cookieSync.domains", [
      "a.example.com",
      "b.example.com",
    ]);

    const latest = createNativeDeviceSettingsSnapshot();
    latest.browser.cookieSync.domains = ["a.example.com", "b.example.com"];
    native.publish(latest);
    await page.updateComplete;
    const external = createNativeDeviceSettingsSnapshot();
    external.browser.cookieSync.domains = ["external.example.com"];
    native.publish(external);
    await page.updateComplete;
    expect(row(page, "Domains").textContent).toContain("external.example.com");
    expect(row(page, "Domains").textContent).not.toContain("b.example.com");
  });

  it("debounces profile typing and flushes the latest edit once when leaving the page", async () => {
    vi.useFakeTimers();
    const { capability } = createCapability();
    const page = await mount("openclaw-device-page", capability);
    const input = row(page, "Target profile").querySelector<HTMLInputElement>("input")!;
    for (const value of ["work", "work-browser"]) {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(capability.set).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(capability.set).toHaveBeenCalledExactlyOnceWith(
      "browser.cookieSync.targetProfile",
      "work-browser",
    );
    input.value = "personal-browser";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    page.remove();
    expect(capability.set).toHaveBeenLastCalledWith(
      "browser.cookieSync.targetProfile",
      "personal-browser",
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(capability.set).toHaveBeenCalledTimes(2);
  });

  it("preserves the latest sent profile across an older native acknowledgement", async () => {
    vi.useFakeTimers();
    const native = createCapability();
    const page = await mount("openclaw-device-page", native.capability);
    const input = row(page, "Target profile").querySelector<HTMLInputElement>("input")!;
    for (const value of ["first-profile", "second-profile"]) {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(400);
    }
    const older = createNativeDeviceSettingsSnapshot();
    older.browser.cookieSync.targetProfile = "first-profile";
    native.publish(older);
    await page.updateComplete;
    expect(input.value).toBe("second-profile");

    input.value += "-final";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(400);
    expect(native.capability.set).toHaveBeenLastCalledWith(
      "browser.cookieSync.targetProfile",
      "second-profile-final",
    );
    const latest = createNativeDeviceSettingsSnapshot();
    latest.browser.cookieSync.targetProfile = "second-profile-final";
    native.publish(latest);
    await page.updateComplete;
    const external = createNativeDeviceSettingsSnapshot();
    external.browser.cookieSync.targetProfile = "external-profile";
    native.publish(external);
    await page.updateComplete;
    expect(input.value).toBe("external-profile");
  });

  it("preserves pending cookie sync edits across page navigation", async () => {
    vi.useFakeTimers();
    const native = createCapability();
    const first = await mount("openclaw-device-page", native.capability);
    const firstDomain = row(first, "Domains").querySelector<HTMLInputElement>("input")!;
    firstDomain.value = "b.example.com";
    firstDomain.dispatchEvent(new Event("input", { bubbles: true }));
    await first.updateComplete;
    row(first, "Domains")
      .querySelector<HTMLFormElement>("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const firstProfile = row(first, "Target profile").querySelector<HTMLInputElement>("input")!;
    firstProfile.value = "pending-profile";
    firstProfile.dispatchEvent(new Event("input", { bubbles: true }));
    first.remove();

    const second = await mount("openclaw-device-page", native.capability);
    const secondDomain = row(second, "Domains").querySelector<HTMLInputElement>("input")!;
    secondDomain.value = "c.example.com";
    secondDomain.dispatchEvent(new Event("input", { bubbles: true }));
    await second.updateComplete;
    row(second, "Domains")
      .querySelector<HTMLFormElement>("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(native.capability.set).toHaveBeenLastCalledWith("browser.cookieSync.domains", [
      "example.com",
      "b.example.com",
      "c.example.com",
    ]);
    const secondProfile = row(second, "Target profile").querySelector<HTMLInputElement>("input")!;
    secondProfile.value += "-remote";
    secondProfile.dispatchEvent(new Event("input", { bubbles: true }));
    second.remove();
    expect(native.capability.set).toHaveBeenLastCalledWith(
      "browser.cookieSync.targetProfile",
      "pending-profile-remote",
    );

    const acknowledged = createNativeDeviceSettingsSnapshot();
    acknowledged.browser.cookieSync.domains = ["example.com", "b.example.com", "c.example.com"];
    acknowledged.browser.cookieSync.targetProfile = "pending-profile-remote";
    native.publish(acknowledged);
    const external = createNativeDeviceSettingsSnapshot();
    external.browser.cookieSync.domains = ["external.example.com"];
    external.browser.cookieSync.targetProfile = "external-profile";
    native.publish(external);
    const third = await mount("openclaw-device-page", native.capability);
    expect(row(third, "Domains").textContent).toContain("external.example.com");
    expect(row(third, "Domains").textContent).not.toContain("b.example.com");
    expect(row(third, "Target profile").querySelector<HTMLInputElement>("input")!.value).toBe(
      "external-profile",
    );
  });

  it("keeps permission order and maps each native status to the correct action", async () => {
    const { capability } = createCapability();
    const page = await mount("openclaw-device-permissions-page", capability);
    const permissions = page.querySelector(".settings-group");
    expect(
      [...permissions!.querySelectorAll(".settings-row__title")].map((element) =>
        element.textContent?.trim(),
      ),
    ).toEqual([
      "Notifications",
      "Accessibility",
      "Screen Recording",
      "Microphone",
      "Camera",
      "Speech Recognition",
      "Location",
      "Automation (Terminal)",
    ]);
    expect(row(page, "Notifications").textContent).toContain("Not determined");
    row(page, "Notifications").querySelector<HTMLButtonElement>("button")!.click();
    expect(capability.requestPermission).toHaveBeenCalledExactlyOnceWith("notifications");
    expect(row(page, "Accessibility").textContent).toContain("Denied");
    row(page, "Accessibility").querySelector<HTMLButtonElement>("button")!.click();
    expect(capability.openSystemSettings).toHaveBeenCalledExactlyOnceWith("accessibility");
    for (const [title, label] of [
      ["Screen Recording", "Granted"],
      ["Automation (Terminal)", "Unavailable"],
    ] as const) {
      expect(row(page, title).textContent).toContain(label);
      expect(row(page, title).querySelector("button")).toBeNull();
    }
  });

  it("enables precision with location access and changes local location and activity preferences", async () => {
    const native = createCapability();
    const page = await mount("openclaw-device-permissions-page", native.capability);
    expect(row(page, "Precise location").querySelector<ToggleElement>("wa-switch")!.disabled).toBe(
      true,
    );
    const modes = row(page, "Location access").querySelector<HTMLElement & { value: string }>(
      "wa-radio-group",
    )!;
    modes.value = "whileUsing";
    modes.dispatchEvent(new Event("change", { bubbles: true }));
    expect(native.capability.set).toHaveBeenCalledWith("permissions.location.mode", "whileUsing");
    const next = createNativeDeviceSettingsSnapshot();
    next.permissions.location.mode = "whileUsing";
    native.publish(next);
    await page.updateComplete;
    expect(row(page, "Precise location").querySelector<ToggleElement>("wa-switch")!.disabled).toBe(
      false,
    );
    toggle(page, "Precise location", true);
    expect(native.capability.set).toHaveBeenCalledWith("permissions.location.precise", true);
    toggle(page, "Active computer presence", true);
    expect(native.capability.set).toHaveBeenCalledWith(
      "capabilities.activeComputerPresenceEnabled",
      true,
    );
    expect(row(page, "Active computer presence").textContent).toContain(
      "Never sends keys, pointer positions, app names, or window titles.",
    );
  });
});
