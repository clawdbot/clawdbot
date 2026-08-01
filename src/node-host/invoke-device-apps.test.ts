import { describe, expect, it, vi } from "vitest";
import type { scanInstalledApps } from "../infra/installed-apps.js";
import { invokeDeviceApps } from "./invoke-device-apps.js";

const scan = vi.fn<typeof scanInstalledApps>(async () => ({
  status: "ok",
  apps: [
    { label: "Calendar", bundleId: "com.apple.iCal", path: "/System/Calendar.app", system: true },
    {
      label: "Notes App",
      bundleId: "com.example.notes",
      path: "/Applications/Notes.app",
      system: false,
    },
    { label: "Other", path: "/Applications/Other.app", system: false },
  ],
}));

describe("invokeDeviceApps", () => {
  it("returns the typed privacy error while sharing is disabled", async () => {
    await expect(
      invokeDeviceApps({ sharingEnabled: false, platform: "darwin", scan }),
    ).resolves.toEqual({
      ok: false,
      code: "INSTALLED_APPS_SHARING_DISABLED",
      message: "INSTALLED_APPS_SHARING_DISABLED: enable Installed Apps in node-host settings",
    });
    expect(scan).not.toHaveBeenCalled();
  });

  it("matches the Android count envelope with macOS app fields", async () => {
    const result = await invokeDeviceApps({
      sharingEnabled: true,
      platform: "darwin",
      paramsJSON: JSON.stringify({ query: "app", limit: 1, includeSystem: false }),
      scan,
    });
    expect(result).toEqual({
      ok: true,
      payload: {
        count: 1,
        totalMatched: 1,
        truncated: false,
        apps: [
          {
            label: "Notes App",
            bundleId: "com.example.notes",
            path: "/Applications/Notes.app",
            system: false,
          },
        ],
      },
    });
  });
});
