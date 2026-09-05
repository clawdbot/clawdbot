/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import type {
  NativeDeviceSettingsCapability,
  NativeDeviceSettingsSnapshot,
  SettingKey,
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
    set: vi.fn<
      (key: SettingKey, value: boolean | string | string[] | null, onSettled?: () => void) => void
    >(),
    requestPermission: vi.fn(),
    openSystemSettings: vi.fn(),
    openPanel: vi.fn(),
    checkForUpdates: vi.fn(),
    refresh: vi.fn(),
    dispose: vi.fn(),
  } satisfies NativeDeviceSettingsCapability;
  return {
    capability,
    settle(index: number, next = createNativeDeviceSettingsSnapshot()) {
      capability.snapshot = next;
      capability.set.mock.calls[index]?.[2]?.();
      listeners.forEach((listener) => listener(next));
    },
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
    const iconStyles = row(page, "Dock icon").querySelector<HTMLSelectElement>("select")!;
    expect(iconStyles.value).toBe("paper");
    expect([...iconStyles.options].map((option) => option.textContent?.trim())).toEqual([
      "Original",
      "Heritage",
      "Clawmark",
      "Origami",
      "Pincer",
      "Open C",
    ]);
    iconStyles.value = "origami";
    iconStyles.dispatchEvent(new Event("change", { bubbles: true }));
    expect(capability.set).toHaveBeenCalledWith("app.iconStyle", "origami");
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
    next.app.iconStyle = {
      selectedId: "origami",
      available: [{ id: "origami", name: "Origami" }],
    };
    native.publish(next);
    await page.updateComplete;
    const iconStyles = row(page, "Dock icon").querySelector<HTMLSelectElement>("select")!;
    expect(iconStyles.value).toBe("origami");
    expect(iconStyles.options).toHaveLength(1);
    delete next.app.iconStyle;
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
    expect(page.querySelector('[aria-label="Dock icon"]')).toBeNull();
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
    expect(capability.set).toHaveBeenLastCalledWith(
      "browser.cookieSync.domains",
      ["example.com", "accounts.example.org"],
      expect.any(Function),
    );
    page.querySelector<HTMLButtonElement>('[aria-label="Remove example.com"]')?.click();
    expect(capability.set).toHaveBeenLastCalledWith(
      "browser.cookieSync.domains",
      ["accounts.example.org"],
      expect.any(Function),
    );
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
    native.settle(0, older);
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>('[aria-label="Remove example.com"]')?.click();
    expect(native.capability.set).toHaveBeenLastCalledWith(
      "browser.cookieSync.domains",
      ["a.example.com", "b.example.com"],
      expect.any(Function),
    );

    const latest = createNativeDeviceSettingsSnapshot();
    latest.browser.cookieSync.domains = ["a.example.com", "b.example.com"];
    native.settle(2, latest);
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
      expect.any(Function),
    );
    input.value = "personal-browser";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    page.remove();
    expect(capability.set).toHaveBeenLastCalledWith(
      "browser.cookieSync.targetProfile",
      "personal-browser",
      expect.any(Function),
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
    native.settle(0, older);
    await page.updateComplete;
    expect(input.value).toBe("second-profile");

    input.value += "-final";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(400);
    expect(native.capability.set).toHaveBeenLastCalledWith(
      "browser.cookieSync.targetProfile",
      "second-profile-final",
      expect.any(Function),
    );
    const latest = createNativeDeviceSettingsSnapshot();
    latest.browser.cookieSync.targetProfile = "second-profile-final";
    native.settle(2, latest);
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
    expect(native.capability.set).toHaveBeenLastCalledWith(
      "browser.cookieSync.domains",
      ["example.com", "b.example.com", "c.example.com"],
      expect.any(Function),
    );
    const secondProfile = row(second, "Target profile").querySelector<HTMLInputElement>("input")!;
    secondProfile.value += "-remote";
    secondProfile.dispatchEvent(new Event("input", { bubbles: true }));
    second.remove();
    expect(native.capability.set).toHaveBeenLastCalledWith(
      "browser.cookieSync.targetProfile",
      "pending-profile-remote",
      expect.any(Function),
    );

    const acknowledged = createNativeDeviceSettingsSnapshot();
    acknowledged.browser.cookieSync.domains = ["example.com", "b.example.com", "c.example.com"];
    acknowledged.browser.cookieSync.targetProfile = "pending-profile-remote";
    native.settle(2, acknowledged);
    native.settle(3, acknowledged);
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

  it("settles cancelled cookie edits after navigation without reusing rejected values", async () => {
    vi.useFakeTimers();
    const native = createCapability();
    const first = await mount("openclaw-device-page", native.capability);
    const domain = row(first, "Domains").querySelector<HTMLInputElement>("input")!;
    domain.value = "rejected.example.com";
    domain.dispatchEvent(new Event("input", { bubbles: true }));
    await first.updateComplete;
    row(first, "Domains")
      .querySelector<HTMLFormElement>("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const profile = row(first, "Target profile").querySelector<HTMLInputElement>("input")!;
    profile.value = "rejected-profile";
    profile.dispatchEvent(new Event("input", { bubbles: true }));
    first.remove();
    const second = await mount("openclaw-device-page", native.capability);
    native.settle(0);
    native.settle(1);
    await second.updateComplete;
    expect(row(second, "Domains").textContent).not.toContain("rejected.example.com");
    expect(row(second, "Target profile").querySelector<HTMLInputElement>("input")!.value).toBe(
      "default",
    );
    second.querySelector<HTMLButtonElement>('[aria-label="Remove example.com"]')!.click();
    expect(native.capability.set.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      "browser.cookieSync.domains",
      [],
    ]);
  });

  it("settles native profile normalization without losing a newer unsent edit", async () => {
    vi.useFakeTimers();
    const native = createCapability();
    const page = await mount("openclaw-device-page", native.capability);
    const input = row(page, "Target profile").querySelector<HTMLInputElement>("input")!;
    input.value = " work ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(400);
    const normalized = createNativeDeviceSettingsSnapshot();
    normalized.browser.cookieSync.targetProfile = "work";
    native.settle(0, normalized);
    await page.updateComplete;
    expect(input.value).toBe("work");
    input.value = "older";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(400);
    input.value = "newer";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    native.settle(1, normalized);
    await page.updateComplete;
    expect(input.value).toBe("newer");
    await vi.advanceTimersByTimeAsync(400);
    native.settle(2, normalized);
    await page.updateComplete;
    expect(input.value).toBe("work");
  });

  it("keeps a newer equal-valued profile pending when the first request settles", async () => {
    vi.useFakeTimers();
    const native = createCapability();
    const page = await mount("openclaw-device-page", native.capability);
    const input = row(page, "Target profile").querySelector<HTMLInputElement>("input")!;
    for (const value of ["first", "middle", "first"]) {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(400);
    }
    const older = createNativeDeviceSettingsSnapshot();
    older.browser.cookieSync.targetProfile = "first";
    native.settle(0, older);
    native.settle(1);
    await page.updateComplete;
    expect(input.value).toBe("first");
    native.settle(2);
    await page.updateComplete;
    expect(input.value).toBe("default");
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
