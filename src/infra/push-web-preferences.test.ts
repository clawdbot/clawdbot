import { describe, expect, it } from "vitest";
import {
  isWebPushQuietHours,
  normalizeWebPushDevicePreferences,
  normalizeWebPushNotificationPreferences,
  resolveEffectiveWebPushPreferences,
  webPushAgentAllowed,
  webPushCategoryEnabled,
} from "./push-web-preferences.js";

describe("Web Push notification preferences", () => {
  it("keeps new attention categories opt-in while preserving approval notifications", () => {
    const preferences = normalizeWebPushNotificationPreferences(undefined);
    expect(preferences.categories).toEqual({
      approvalRequested: true,
      agentFinished: false,
      agentQuestion: false,
      humanMentioned: false,
      scheduledTaskFailed: false,
      backgroundTaskFailed: false,
    });
  });

  it("applies per-device overrides without changing user defaults", () => {
    const defaults = normalizeWebPushNotificationPreferences(undefined);
    const user = {
      ...defaults,
      categories: {
        ...defaults.categories,
        agentQuestion: true,
      },
      detailLevel: "identified" as const,
    };
    const effective = resolveEffectiveWebPushPreferences({
      user,
      device: {
        enabled: true,
        label: "Slot 1",
        categories: { agentQuestion: false, backgroundTaskFailed: true, humanMentioned: true },
      },
    });

    expect(effective.label).toBe("Slot 1");
    expect(effective.detailLevel).toBe("identified");
    expect(webPushCategoryEnabled(effective, "agent-question")).toBe(false);
    expect(webPushCategoryEnabled(effective, "background-task-failed")).toBe(true);
    expect(webPushCategoryEnabled(effective, "human-mentioned")).toBe(true);
    expect(user.categories.agentQuestion).toBe(true);
    expect(user.categories.humanMentioned).toBe(false);
  });

  it("handles overnight quiet hours in the configured time zone", () => {
    const defaults = normalizeWebPushNotificationPreferences(undefined);
    const effective = resolveEffectiveWebPushPreferences({
      user: {
        ...defaults,
        quietHours: {
          enabled: true,
          startMinute: 22 * 60,
          endMinute: 7 * 60,
          timeZone: "America/Chicago",
        },
      },
    });
    expect(isWebPushQuietHours(effective, Date.parse("2026-08-28T04:30:00Z"))).toBe(true);
    expect(isWebPushQuietHours(effective, Date.parse("2026-08-28T18:00:00Z"))).toBe(false);
  });

  it("normalizes device labels and agent allowlists", () => {
    const device = normalizeWebPushDevicePreferences({
      enabled: true,
      label: "  Production  ",
      agentIds: ["main", "main", "research"],
    });
    const effective = resolveEffectiveWebPushPreferences({ device });
    expect(device.label).toBe("Production");
    expect(effective.agentIds).toEqual(["main", "research"]);
    expect(webPushAgentAllowed(effective, "main")).toBe(true);
    expect(webPushAgentAllowed(effective, "other")).toBe(false);
  });
});
