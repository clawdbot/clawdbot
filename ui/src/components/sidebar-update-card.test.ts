/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateAvailable } from "../api/types.ts";
import {
  NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT,
  NATIVE_UPDATE_DECLINED_EVENT,
} from "../app/native-link-routing.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import "./sidebar-update-card.ts";

const DISMISS_KEY = "openclaw:control-ui:update-banner-dismissed:v1";

type SidebarUpdateCardElement = HTMLElement & {
  updateAvailable: UpdateAvailable | null;
  updateRunning: boolean;
  onUpdate: () => void;
  updateComplete: Promise<boolean>;
};

let originalWebkit: PropertyDescriptor | undefined;
let originalLocalStorage: PropertyDescriptor | undefined;

async function mount(update: UpdateAvailable | null) {
  const element = document.createElement(
    "openclaw-sidebar-update-card",
  ) as SidebarUpdateCardElement;
  element.updateAvailable = update;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

beforeEach(() => {
  originalWebkit = Object.getOwnPropertyDescriptor(window, "webkit");
  originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: createStorageMock(),
  });
});

afterEach(() => {
  document.body.replaceChildren();
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
  if (originalWebkit) {
    Object.defineProperty(window, "webkit", originalWebkit);
  } else {
    Reflect.deleteProperty(window, "webkit");
  }
});

describe("SidebarUpdateCard", () => {
  it("labels a direct Gateway update and invokes its action", async () => {
    const element = await mount({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    });
    const onUpdate = vi.fn();
    element.onUpdate = onUpdate;

    const action = element.querySelector<HTMLButtonElement>(".sidebar-update-card__action");
    expect(element.querySelector(".sidebar-update-card")?.getAttribute("role")).toBe("status");
    expect(element.querySelector(".sidebar-update-card__text")?.textContent).toBe(
      "Update Gateway · v2.0.0",
    );
    expect(element.querySelector(".sidebar-update-card__copy")).toBeNull();
    expect(element.querySelector(".sidebar-update-card__subtitle")).toBeNull();
    expect(element.querySelector(".sidebar-update-card__arrow")).toBeNull();
    action?.click();

    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it.each([null, { currentVersion: "2.0.0", latestVersion: "2.0.0", channel: "stable" }] as const)(
    "renders nothing when no newer update is available",
    async (update) => {
      const element = await mount(update);
      expect(element.querySelector(".sidebar-update-card")).toBeNull();
    },
  );

  it("renders nothing for a dismissed version and channel", async () => {
    localStorage.setItem(
      DISMISS_KEY,
      JSON.stringify({ latestVersion: "2.0.0", channel: "beta", dismissedAtMs: 1 }),
    );
    const element = await mount({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "beta",
    });
    expect(element.querySelector(".sidebar-update-card")).toBeNull();
  });

  it("labels and routes a coordinated Mac app and managed Gateway update", async () => {
    const postMessage = vi.fn();
    Object.defineProperty(window, "webkit", {
      configurable: true,
      value: { messageHandlers: { openclawUpdate: { postMessage } } },
    });
    const element = await mount({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    });
    const onUpdate = vi.fn();
    element.onUpdate = onUpdate;

    const action = element.querySelector<HTMLButtonElement>(".sidebar-update-card__action");
    expect(action?.textContent).toContain("Update Mac app + Gateway");
    expect(action?.textContent).toContain("v2.0.0");
    action?.click();

    expect(postMessage).toHaveBeenCalledWith({ type: "start-update" });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("updates the visible target when native ownership changes", async () => {
    const element = await mount({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    });
    expect(element.textContent).toContain("Update Gateway");

    Object.defineProperty(window, "webkit", {
      configurable: true,
      value: { messageHandlers: { openclawUpdate: { postMessage: vi.fn() } } },
    });
    window.dispatchEvent(new CustomEvent(NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT));
    await element.updateComplete;
    expect(element.textContent).toContain("Update Mac app + Gateway");

    Reflect.deleteProperty(window, "webkit");
    window.dispatchEvent(new CustomEvent(NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT));
    await element.updateComplete;
    expect(element.textContent).toContain("Update Gateway");
  });

  it("uses a newly installed native bridge before its availability event arrives", async () => {
    const element = await mount({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    });
    const onUpdate = vi.fn();
    const postMessage = vi.fn();
    element.onUpdate = onUpdate;
    expect(element.textContent).toContain("Update Gateway");

    Object.defineProperty(window, "webkit", {
      configurable: true,
      value: { messageHandlers: { openclawUpdate: { postMessage } } },
    });
    element.querySelector<HTMLButtonElement>(".sidebar-update-card__action")?.click();

    expect(postMessage).toHaveBeenCalledWith({ type: "start-update" });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("returns a declined native click to the gateway while connected", async () => {
    const element = await mount({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    });
    const onUpdate = vi.fn();
    element.onUpdate = onUpdate;

    window.dispatchEvent(new CustomEvent(NATIVE_UPDATE_DECLINED_EVENT));
    expect(onUpdate).toHaveBeenCalledOnce();

    element.updateRunning = true;
    window.dispatchEvent(new CustomEvent(NATIVE_UPDATE_DECLINED_EVENT));
    expect(onUpdate).toHaveBeenCalledOnce();

    element.updateRunning = false;
    element.updateAvailable = null;
    window.dispatchEvent(new CustomEvent(NATIVE_UPDATE_DECLINED_EVENT));
    expect(onUpdate).toHaveBeenCalledOnce();

    element.remove();
    window.dispatchEvent(new CustomEvent(NATIVE_UPDATE_DECLINED_EVENT));
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("keeps later clicks on the displayed Gateway route after a native decline", async () => {
    const postMessage = vi.fn();
    Object.defineProperty(window, "webkit", {
      configurable: true,
      value: { messageHandlers: { openclawUpdate: { postMessage } } },
    });
    const element = await mount({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    });
    const onUpdate = vi.fn();
    element.onUpdate = onUpdate;

    window.dispatchEvent(new CustomEvent(NATIVE_UPDATE_DECLINED_EVENT));
    await element.updateComplete;
    expect(element.textContent).toContain("Update Gateway");

    element.querySelector<HTMLButtonElement>(".sidebar-update-card__action")?.click();
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(postMessage).not.toHaveBeenCalled();

    window.dispatchEvent(new CustomEvent(NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT));
    await element.updateComplete;
    expect(element.textContent).toContain("Update Mac app + Gateway");
    element.querySelector<HTMLButtonElement>(".sidebar-update-card__action")?.click();
    expect(postMessage).toHaveBeenCalledWith({ type: "start-update" });
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it("keeps a declined Gateway route consistent across reconnection", async () => {
    const postMessage = vi.fn();
    Object.defineProperty(window, "webkit", {
      configurable: true,
      value: { messageHandlers: { openclawUpdate: { postMessage } } },
    });
    const element = await mount({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    });
    const onUpdate = vi.fn();
    element.onUpdate = onUpdate;

    window.dispatchEvent(new CustomEvent(NATIVE_UPDATE_DECLINED_EVENT));
    await element.updateComplete;
    element.remove();
    document.body.append(element);
    await element.updateComplete;

    expect(element.textContent).toContain("Update Gateway");
    element.querySelector<HTMLButtonElement>(".sidebar-update-card__action")?.click();
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("disables the action while updating", async () => {
    const element = await mount({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    });
    element.updateRunning = true;
    await element.updateComplete;

    const action = element.querySelector<HTMLButtonElement>(".sidebar-update-card__action");
    expect(action?.disabled).toBe(true);
    expect(action?.textContent).toContain("Updating…");
  });

  it("persists dismissal and hides the card", async () => {
    const element = await mount({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    });
    element.querySelector<HTMLButtonElement>(".sidebar-update-card__dismiss")?.click();
    await element.updateComplete;

    expect(JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "null")).toMatchObject({
      latestVersion: "2.0.0",
      channel: "stable",
    });
    expect(element.querySelector(".sidebar-update-card")).toBeNull();
  });

  it("hides the card when dismissal persistence fails", async () => {
    const storage = createStorageMock();
    storage.setItem = () => {
      throw new Error("quota exceeded");
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    const update = { currentVersion: "1.0.0", latestVersion: "3.0.0", channel: "stable" };
    const element = await mount(update);

    element.querySelector<HTMLButtonElement>(".sidebar-update-card__dismiss")?.click();
    await element.updateComplete;

    expect(element.querySelector(".sidebar-update-card")).toBeNull();
    element.remove();
    const replacement = await mount(update);
    expect(replacement.querySelector(".sidebar-update-card")).not.toBeNull();
  });

  it("shows a newer update after dismissing an older version", async () => {
    const element = await mount({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    });
    element.querySelector<HTMLButtonElement>(".sidebar-update-card__dismiss")?.click();
    await element.updateComplete;

    element.updateAvailable = {
      currentVersion: "1.0.0",
      latestVersion: "3.0.0",
      channel: "stable",
    };
    await element.updateComplete;

    expect(element.querySelector(".sidebar-update-card")?.textContent).toContain("v3.0.0");
  });
});
