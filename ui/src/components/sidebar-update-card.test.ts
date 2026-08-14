/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import {
  NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT,
  NATIVE_UPDATE_DECLINED_EVENT,
} from "../app/native-link-routing.ts";
import {
  answerConfirmDialog,
  cancelOpenModalDialogs,
  installDialogPolyfill,
  waitForConfirmDialogActions,
} from "../test-helpers/modal-dialog.ts";
import "./sidebar-update-card.ts";

/** Resolve the update confirmation the card opens, then let its dispatch settle. */
async function resolveUpdateConfirmation(
  label: "Cancel" | "Update and restart" | "Update Mac app and restart",
) {
  const actions = await waitForConfirmDialogActions();
  expect(actions.textContent).toContain(label);
  answerConfirmDialog(actions, label === "Cancel" ? "cancel" : "confirm");
}

type SidebarUpdateCardElement = HTMLElement & {
  updateAvailable: UpdateAvailable | null;
  updateSchedule: UpdateScheduleState | null;
  heldUpdateCampaignId: string | null;
  updateBusy: boolean;
  canUpdate: boolean;
  canHoldUpdate: boolean;
  onUpdate: () => void;
  refreshRequired: boolean;
  onRefresh: () => void;
  onHoldUpdate: () => Promise<boolean>;
  updateComplete: Promise<boolean>;
};

let originalWebkit: PropertyDescriptor | undefined;
let restoreDialogPolyfill: () => void;

async function mount(
  update: UpdateAvailable | null,
  schedule: UpdateScheduleState | null = null,
  canUpdate = true,
  canHoldUpdate = true,
) {
  const element = document.createElement(
    "openclaw-sidebar-update-card",
  ) as SidebarUpdateCardElement;
  element.updateAvailable = update;
  element.updateSchedule = schedule;
  element.canUpdate = canUpdate;
  element.canHoldUpdate = canHoldUpdate;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

beforeEach(() => {
  restoreDialogPolyfill = installDialogPolyfill();
  originalWebkit = Object.getOwnPropertyDescriptor(window, "webkit");
});

afterEach(() => {
  vi.useRealTimers();
  cancelOpenModalDialogs();
  document.body.replaceChildren();
  restoreDialogPolyfill();
  if (originalWebkit) {
    Object.defineProperty(window, "webkit", originalWebkit);
  } else {
    Reflect.deleteProperty(window, "webkit");
  }
  vi.resetModules();
});

describe("SidebarUpdateCard", () => {
  it("renders the refresh state and invokes its action", async () => {
    const element = await mount(null);
    const onRefresh = vi.fn();
    element.refreshRequired = true;
    element.onRefresh = onRefresh;
    await element.updateComplete;

    const card = element.querySelector(".sidebar-update-card");
    expect(card?.getAttribute("role")).toBe("status");
    expect(card?.getAttribute("aria-live")).toBe("polite");
    expect(element.querySelector(".sidebar-update-card__title")?.textContent).toBe(
      "Server updated",
    );
    expect(element.querySelector(".sidebar-update-card__subtitle")?.textContent).toBe(
      "Refresh for full capabilities",
    );
    element.querySelector<HTMLButtonElement>(".sidebar-update-card__action")?.click();

    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("gives the refresh state precedence over an available update", async () => {
    const element = await mount({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    });
    const onRefresh = vi.fn();
    const onUpdate = vi.fn();
    element.refreshRequired = true;
    element.onRefresh = onRefresh;
    element.onUpdate = onUpdate;
    await element.updateComplete;

    expect(element.textContent).toContain("Server updated");
    expect(element.textContent).not.toContain("Update Gateway");
    expect(element.textContent).not.toContain("v2.0.0");
    element.querySelector<HTMLButtonElement>(".sidebar-update-card__action")?.click();

    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("renders one explicit CTA and confirms before invoking a direct Gateway update", async () => {
    const element = await mount({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    });
    const onUpdate = vi.fn();
    element.onUpdate = onUpdate;

    const availability = element.querySelector<HTMLElement>(".sidebar-update-card__availability");
    const action = element.querySelector<HTMLButtonElement>(".sidebar-update-card__cta");
    expect(element.querySelector(".sidebar-update-card")?.getAttribute("role")).toBe("status");
    expect(availability?.tagName).toBe("DIV");
    expect(availability?.hasAttribute("tabindex")).toBe(false);
    expect(element.querySelector(".sidebar-update-card__text")?.textContent).toBe(
      "New version available",
    );
    expect(action?.textContent?.trim()).toBe("Update");
    expect(availability?.querySelectorAll("button")).toHaveLength(1);
    expect(element.querySelector(".sidebar-update-card__copy")).toBeNull();
    expect(element.querySelector(".sidebar-update-card__subtitle")).toBeNull();
    expect(element.querySelector(".sidebar-update-card__arrow")).toBeNull();
    availability?.click();
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();
    action?.click();
    await waitForConfirmDialogActions();

    expect(onUpdate).not.toHaveBeenCalled();
    await resolveUpdateConfirmation("Update and restart");
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("leaves the Gateway untouched when the operator cancels the confirmation", async () => {
    const element = await mount({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    });
    const onUpdate = vi.fn();
    element.onUpdate = onUpdate;

    element.querySelector<HTMLButtonElement>(".sidebar-update-card__cta")?.click();
    await resolveUpdateConfirmation("Cancel");

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it.each(["2026.7.2", "2026.7.2-beta.5"])(
    "keeps the availability copy stable when the beta version is %s",
    async (latestVersion) => {
      const element = await mount({
        currentVersion: "2026.7.1-2",
        latestVersion,
        channel: "beta",
      });

      expect(element.querySelector(".sidebar-update-card__text")?.textContent).toBe(
        "New version available",
      );
    },
  );

  it.each([null, { currentVersion: "2.0.0", latestVersion: "2.0.0", channel: "stable" }] as const)(
    "renders nothing when no newer update is available",
    async (update) => {
      const element = await mount(update);
      expect(element.querySelector(".sidebar-update-card")).toBeNull();
    },
  );

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

    const action = element.querySelector<HTMLButtonElement>(".sidebar-update-card__cta");
    expect(element.querySelector(".sidebar-update-card__text")?.textContent).toBe(
      "New version available",
    );
    action?.click();
    await waitForConfirmDialogActions();

    expect(postMessage).not.toHaveBeenCalled();
    await resolveUpdateConfirmation("Update Mac app and restart");
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "start-update" });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("keeps availability copy stable when native ownership changes", async () => {
    const element = await mount({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    });
    expect(element.textContent).toContain("New version available");

    Object.defineProperty(window, "webkit", {
      configurable: true,
      value: { messageHandlers: { openclawUpdate: { postMessage: vi.fn() } } },
    });
    window.dispatchEvent(new CustomEvent(NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT));
    await element.updateComplete;
    expect(element.textContent).toContain("New version available");

    Reflect.deleteProperty(window, "webkit");
    window.dispatchEvent(new CustomEvent(NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT));
    await element.updateComplete;
    expect(element.textContent).toContain("New version available");
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
    expect(element.textContent).toContain("New version available");

    Object.defineProperty(window, "webkit", {
      configurable: true,
      value: { messageHandlers: { openclawUpdate: { postMessage } } },
    });
    element.querySelector<HTMLButtonElement>(".sidebar-update-card__cta")?.click();
    await resolveUpdateConfirmation("Update Mac app and restart");

    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "start-update" });
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

    element.updateBusy = true;
    window.dispatchEvent(new CustomEvent(NATIVE_UPDATE_DECLINED_EVENT));
    expect(onUpdate).toHaveBeenCalledOnce();

    element.updateBusy = false;
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
    expect(element.textContent).toContain("New version available");

    element.querySelector<HTMLButtonElement>(".sidebar-update-card__cta")?.click();
    await resolveUpdateConfirmation("Update and restart");
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(postMessage).not.toHaveBeenCalled();

    window.dispatchEvent(new CustomEvent(NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT));
    await element.updateComplete;
    expect(element.textContent).toContain("New version available");
    element.querySelector<HTMLButtonElement>(".sidebar-update-card__cta")?.click();
    await resolveUpdateConfirmation("Update Mac app and restart");
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "start-update" });
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

    expect(element.textContent).toContain("New version available");
    element.querySelector<HTMLButtonElement>(".sidebar-update-card__cta")?.click();
    await resolveUpdateConfirmation("Update and restart");
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("narrates the whole update, including after the Gateway drops its metadata", async () => {
    const element = await mount(
      { currentVersion: "1.0.0", latestVersion: "1.0.0", channel: "dev", commitsBehind: 246 },
      {
        channel: "dev",
        autoEnabled: false,
        target: {
          kind: "git",
          upstreamRef: "origin/main",
          upstreamSha: "abc1234def",
          commitsBehind: 246,
        },
      },
    );
    expect(element.textContent).toContain("New version available");

    element.updateBusy = true;
    await element.updateComplete;
    const action = element.querySelector<HTMLButtonElement>(".sidebar-update-card__action");
    expect(action?.disabled).toBe(true);
    expect(action?.textContent).toContain("Updating Gateway…");
    // The stale call to action must not survive into the install.
    expect(element.textContent).not.toContain("New version available");

    // The restarting Gateway takes its update metadata with it; the card is the
    // operator's only remaining sign that an install is still running.
    element.updateAvailable = null;
    element.updateSchedule = null;
    await element.updateComplete;
    expect(element.textContent).toContain("Updating Gateway…");
  });

  it("renders a quiet live countdown and stops ticking on disconnect", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    const element = await mount(
      {
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
        channel: "stable",
      },
      {
        channel: "stable",
        autoEnabled: true,
        target: { kind: "package", version: "2.0.0" },
        campaign: {
          id: "campaign-1",
          state: "countdown",
          announcedAtMs: 0,
          applyAtMs: 55_000,
          forceAtMs: 900_000,
          updatedAtMs: 0,
        },
      },
    );

    const card = element.querySelector(".sidebar-update-card");
    const timer = element.querySelector("[role='timer']");
    expect(card?.hasAttribute("role")).toBe(false);
    expect(timer?.getAttribute("aria-live")).toBe("off");
    expect(timer?.textContent).toContain("Updating in 0:54 · v2.0.0");
    expect(element.querySelector(".sidebar-update-card__hold")?.textContent?.trim()).toBe(
      "Hold 1 h",
    );

    element.updateBusy = true;
    await element.updateComplete;
    expect(element.querySelector(".sidebar-update-card__hold")).toBeNull();
    element.updateBusy = false;
    await element.updateComplete;
    expect(element.querySelector(".sidebar-update-card__hold")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    await element.updateComplete;
    expect(element.querySelector("[role='timer']")?.textContent).toContain("Updating in 0:53");

    element.remove();
    expect(clearInterval).toHaveBeenCalled();
  });

  it("keeps a consumed hold hidden across shared-state rerenders after expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const element = await mount(
      {
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
        channel: "stable",
      },
      {
        channel: "stable",
        autoEnabled: true,
        target: { kind: "package", version: "2.0.0" },
        campaign: {
          id: "campaign-1",
          state: "waiting-for-idle",
          announcedAtMs: 0,
          forceAtMs: 900_000,
          updatedAtMs: 0,
        },
      },
    );
    const onHoldUpdate = vi.fn(async () => true);
    element.onHoldUpdate = onHoldUpdate;

    element.querySelector<HTMLButtonElement>(".sidebar-update-card__hold")?.click();
    await Promise.resolve();
    await element.updateComplete;

    expect(onHoldUpdate).toHaveBeenCalledOnce();
    element.heldUpdateCampaignId = "campaign-1";
    element.updateSchedule = {
      ...element.updateSchedule!,
      campaign: {
        ...element.updateSchedule!.campaign!,
        holdUntilMs: 61_000,
      },
    };
    await element.updateComplete;
    expect(element.querySelector(".sidebar-update-card__hold")).toBeNull();

    element.updateSchedule = {
      ...element.updateSchedule!,
      campaign: {
        ...element.updateSchedule!.campaign!,
        holdUntilMs: 500,
      },
    };
    await element.updateComplete;
    expect(element.querySelector(".sidebar-update-card__hold")).toBeNull();
  });

  it("renders held timing and gates hold for active or unauthorized campaigns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const schedule: UpdateScheduleState = {
      channel: "dev",
      autoEnabled: true,
      target: {
        kind: "git",
        upstreamRef: "origin/main",
        upstreamSha: "a".repeat(40),
        commitsBehind: 2,
      },
      campaign: {
        id: "campaign-1",
        state: "waiting-for-idle",
        announcedAtMs: 0,
        holdUntilMs: 61_000,
        forceAtMs: 961_000,
        updatedAtMs: 1_000,
      },
    };
    const held = await mount(null, schedule);
    expect(held.textContent).toContain("Update held · resumes in 1:00");
    expect(held.querySelector(".sidebar-update-card__hold")).toBeNull();

    const unheldSchedule: UpdateScheduleState = {
      ...schedule,
      campaign: { ...schedule.campaign!, holdUntilMs: undefined },
    };
    const unauthorized = await mount(null, unheldSchedule, false);
    expect(unauthorized.querySelector(".sidebar-update-card__hold")).toBeNull();

    const unsupported = await mount(null, unheldSchedule, true, false);
    expect(unsupported.querySelector(".sidebar-update-card__hold")).toBeNull();
  });

  it("disables the update action when the operator cannot administer updates", async () => {
    const element = await mount(
      {
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
        channel: "stable",
      },
      null,
      false,
    );
    const onUpdate = vi.fn();
    element.onUpdate = onUpdate;

    const action = element.querySelector<HTMLButtonElement>(".sidebar-update-card__cta");
    expect(action?.disabled).toBe(true);
    expect(action?.title).toContain("Administrator access is required");
    action?.click();
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
