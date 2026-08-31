import { describe, expect, it } from "vitest";
import {
  isWebPushQuietHours,
  normalizeWebPushDevicePreferences,
  normalizeWebPushNotificationPreferences,
  resolveEffectiveWebPushPreferences,
  webPushAgentAllowed,
  webPushCategoryDeliveryMode,
} from "./push-web-preferences.js";

describe("Web Push notification preferences", () => {
  it("keeps new attention categories opt-in while preserving approval notifications", () => {
    const preferences = normalizeWebPushNotificationPreferences(undefined);
    expect(preferences.categories).toEqual({
      approvalRequested: "always",
      agentFinished: "never",
      agentQuestion: "never",
      scheduledTaskFailed: "never",
      backgroundTaskFailed: "never",
    });
  });

  it("applies per-device overrides without changing user defaults", () => {
    const defaults = normalizeWebPushNotificationPreferences(undefined);
    const user = {
      ...defaults,
      categories: {
        ...defaults.categories,
        agentQuestion: "unfocused" as const,
      },
      detailLevel: "identified" as const,
    };
    const effective = resolveEffectiveWebPushPreferences({
      user,
      device: {
        enabled: true,
        label: "Slot 1",
        categories: { agentQuestion: "never", backgroundTaskFailed: "always" },
      },
    });

    expect(effective.label).toBe("Slot 1");
    expect(effective.detailLevel).toBe("identified");
    expect(webPushCategoryDeliveryMode(effective, "agent-question")).toBe("never");
    expect(webPushCategoryDeliveryMode(effective, "background-task-failed")).toBe("always");
    expect(user.categories.agentQuestion).toBe("unfocused");
  });

  it("migrates the short-lived boolean preference shape to delivery modes", () => {
    expect(
      normalizeWebPushNotificationPreferences({
        categories: { approvalRequested: false, agentFinished: true },
      }).categories,
    ).toMatchObject({ approvalRequested: "never", agentFinished: "always" });
    expect(
      normalizeWebPushDevicePreferences({
        enabled: true,
        label: "",
        categories: { agentQuestion: true },
      }).categories,
    ).toEqual({ agentQuestion: "always" });
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
