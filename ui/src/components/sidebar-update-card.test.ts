/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import type { ApplicationStatusBanner } from "../app/update-overlay-helpers.ts";
import "./sidebar-update-card.ts";

type SidebarUpdateCardElement = HTMLElement & {
  updateAvailable: UpdateAvailable | null;
  updateSchedule: UpdateScheduleState | null;
  compact: boolean;
  heldUpdateCampaignId: string | null;
  updateBusy: boolean;
  canUpdate: boolean;
  canHoldUpdate: boolean;
  onUpdate: () => void;
  refreshRequired: boolean;
  onRefresh: () => Promise<boolean>;
  onHoldUpdate: () => Promise<boolean>;
  statusBanner: ApplicationStatusBanner | null;
  onReviewUpdate: () => void;
  updateComplete: Promise<boolean>;
};

let originalWebkit: PropertyDescriptor | undefined;

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
  originalWebkit = Object.getOwnPropertyDescriptor(window, "webkit");
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  if (originalWebkit) {
    Object.defineProperty(window, "webkit", originalWebkit);
  } else {
    Reflect.deleteProperty(window, "webkit");
  }
});

describe("SidebarUpdateCard", () => {
  it("renders the refresh state and invokes its action", async () => {
    const element = await mount(null);
    const onRefresh = vi.fn(async () => false);
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

  it("restores an actionable retry after stale-client recovery cannot reach the Gateway", async () => {
    const element = await mount(null);
    let completeRefresh: ((reloading: boolean) => void) | undefined;
    const firstRefresh = new Promise<boolean>((resolve) => {
      completeRefresh = resolve;
    });
    const onRefresh = vi
      .fn<() => Promise<boolean>>()
      .mockReturnValueOnce(firstRefresh)
      .mockResolvedValue(false);
    element.refreshRequired = true;
    element.onRefresh = onRefresh;
    await element.updateComplete;

    const action = element.querySelector<HTMLButtonElement>(".sidebar-update-card__action");
    action?.click();
    await element.updateComplete;

    expect(action?.disabled).toBe(true);
    expect(action?.textContent).toContain("Reloading…");
    action?.click();
    expect(onRefresh).toHaveBeenCalledOnce();

    completeRefresh?.(false);
    await vi.waitFor(() => expect(action?.disabled).toBe(false));
    expect(element.textContent).toContain("Actions are unavailable while the Gateway reconnects.");
    expect(action?.textContent).toContain("Retry now");

    action?.click();
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it("ignores an obsolete refresh result after recovery state is re-established", async () => {
    const element = await mount(null);
    let completeFirst: ((reloading: boolean) => void) | undefined;
    let completeSecond: ((reloading: boolean) => void) | undefined;
    const onRefresh = vi
      .fn<() => Promise<boolean>>()
      .mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          completeFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          completeSecond = resolve;
        }),
      );
    element.refreshRequired = true;
    element.onRefresh = onRefresh;
    await element.updateComplete;

    element.querySelector<HTMLButtonElement>(".sidebar-update-card__action")?.click();
    await element.updateComplete;

    element.refreshRequired = false;
    await element.updateComplete;
    element.refreshRequired = true;
    await element.updateComplete;
    const action = element.querySelector<HTMLButtonElement>(".sidebar-update-card__action");
    action?.click();
    await element.updateComplete;
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(action?.disabled).toBe(true);

    completeFirst?.(false);
    await element.updateComplete;
    expect(action?.disabled).toBe(true);
    expect(element.textContent).not.toContain(
      "Actions are unavailable while the Gateway reconnects.",
    );

    completeSecond?.(false);
    await vi.waitFor(() => expect(action?.disabled).toBe(false));
    expect(element.textContent).toContain("Actions are unavailable while the Gateway reconnects.");
  });

  it("gives the refresh state precedence over an available update", async () => {
    const element = await mount({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    });
    const onRefresh = vi.fn(async () => false);
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

  it("routes a recorded failure to update settings when availability is gone", async () => {
    const element = await mount(null);
    const onReviewUpdate = vi.fn();
    element.statusBanner = { tone: "danger", text: "Update failed" };
    element.onReviewUpdate = onReviewUpdate;
    await element.updateComplete;

    expect(element.textContent).toContain("Update failed");
    element.querySelector<HTMLButtonElement>(".sidebar-update-card__review")?.click();
    expect(onReviewUpdate).toHaveBeenCalledOnce();
  });

  it("renders an available update and narrates it after the Gateway drops its metadata", async () => {
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
    expect(element.querySelector(".sidebar-update-card__action")?.textContent).toContain(
      "246 commits behind",
    );

    element.updateBusy = true;
    await element.updateComplete;
    const action = element.querySelector<HTMLButtonElement>(".sidebar-update-card__action");
    expect(action?.disabled).toBe(true);
    expect(action?.textContent).toContain("Updating Gateway…");

    element.updateAvailable = null;
    element.updateSchedule = null;
    await element.updateComplete;
    expect(element.textContent).toContain("Updating Gateway…");
  });

  it("keeps an available update actionable inside the compact Inbox row", async () => {
    const element = await mount({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    });
    element.compact = true;
    await element.updateComplete;

    expect(element.querySelector(".sidebar-issues-panel__entity")?.textContent).toBe(
      "Update available",
    );
    expect(element.querySelector(".sidebar-update-card__action")?.textContent).toContain(
      "Update Gateway",
    );
  });

  it("keeps an unauthorized update discoverable without allowing activation", async () => {
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

    const action = element.querySelector<HTMLButtonElement>(".sidebar-update-card__action");
    const tooltip = action?.closest("openclaw-tooltip") as
      | (HTMLElement & { content?: string; updateComplete: Promise<boolean> })
      | null;
    await tooltip?.updateComplete;

    expect(action?.disabled).toBe(false);
    expect(action?.getAttribute("aria-disabled")).toBe("true");
    expect(action?.getAttribute("aria-describedby")).not.toBeNull();
    expect(tooltip?.hasAttribute("open-on-click")).toBe(true);
    expect(tooltip?.content).toContain("Administrator access is required");
    action?.click();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("renders a quiet live countdown and stops ticking on disconnect", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    const element = await mount(
      { currentVersion: "1.0.0", latestVersion: "2.0.0", channel: "stable" },
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
      { currentVersion: "1.0.0", latestVersion: "2.0.0", channel: "stable" },
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
      campaign: { ...element.updateSchedule!.campaign!, holdUntilMs: 61_000 },
    };
    await element.updateComplete;
    expect(element.querySelector(".sidebar-update-card__hold")).toBeNull();

    element.updateSchedule = {
      ...element.updateSchedule!,
      campaign: { ...element.updateSchedule!.campaign!, holdUntilMs: 500 },
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
});
