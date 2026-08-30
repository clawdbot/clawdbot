/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderNotificationsSection } from "./notifications-section.ts";

const userPreferences = {
  categories: {
    approvalRequested: true,
    agentFinished: false,
    agentQuestion: false,
    scheduledTaskFailed: false,
    backgroundTaskFailed: false,
  },
  detailLevel: "private" as const,
  quietHours: { enabled: true, startMinute: 1320, endMinute: 420, timeZone: "UTC" },
  agentIds: [],
};

describe("native notification test outcome", () => {
  it("renders pending immediately and disables duplicate sends", () => {
    const onSend = vi.fn();
    const container = document.createElement("div");

    render(
      renderNotificationsSection({
        connected: true,
        nativeNotifications: { permission: "granted", test: { state: "pending" } },
        onNativeNotificationsSendTest: onSend,
      }),
      container,
    );

    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain("Sending test");
    button?.click();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("renders an actionable error without replacing granted permission", () => {
    const container = document.createElement("div");

    render(
      renderNotificationsSection({
        connected: true,
        nativeNotifications: {
          permission: "granted",
          test: { state: "error", message: "Open System Settings and try again." },
        },
      }),
      container,
    );

    expect(container.textContent).toContain("Granted");
    expect(container.textContent).toContain("Open System Settings and try again.");
    expect(container.querySelector(".settings-status--danger")).not.toBeNull();
  });

  it("renders queued success independently from permission", () => {
    const container = document.createElement("div");
    render(
      renderNotificationsSection({
        connected: true,
        nativeNotifications: { permission: "granted", test: { state: "sent" } },
      }),
      container,
    );

    expect(container.textContent).toContain("Granted");
    expect(container.textContent).toContain("Test notification queued");
  });
});

describe("Web Push preference saves", () => {
  it("disables every preference control while a save is in flight", () => {
    const container = document.createElement("div");

    render(
      renderNotificationsSection({
        connected: true,
        webPush: {
          supported: true,
          permission: "granted",
          subscription: "registered",
          loading: true,
          preferences: {
            durableIdentity: true,
            user: userPreferences,
            device: {
              enabled: true,
              label: "phone",
              quietHours: { enabled: true, startMinute: 1320, endMinute: 420, timeZone: "UTC" },
              agentIds: [],
            },
            effective: { ...userPreferences, enabled: true, label: "phone" },
          },
        },
      }),
      container,
    );

    const preferences = container.querySelector<HTMLElement>(".settings-page > .settings-stack");
    const preferenceGroup = expectDefined(preferences, "notification preferences group");
    expect(preferenceGroup.querySelectorAll("wa-switch.settings-toggle")).toHaveLength(7);
    expect(preferenceGroup.querySelectorAll("select.settings-select")).toHaveLength(9);
    expect(preferenceGroup.querySelectorAll("input.settings-input")).toHaveLength(9);
    expect(preferenceGroup.querySelector('input[type="checkbox"]')).toBeNull();
    expect(
      [...preferenceGroup.querySelectorAll('input[type="text"], input[type="time"]')].every(
        (input) => input.classList.contains("settings-input") && input.hasAttribute("aria-label"),
      ),
    ).toBe(true);
    expect(
      [...preferenceGroup.querySelectorAll("select.settings-select")].every((select) =>
        select.hasAttribute("aria-label"),
      ),
    ).toBe(true);
    expect(preferenceGroup.hasAttribute("inert")).toBe(true);
  });
});
