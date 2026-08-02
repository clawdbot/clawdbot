import { describe, expect, it } from "vitest";
import { mapStartupPluginQuarantineRefresh } from "./doctor-config-preflight-plugin-verification.js";

describe("mapStartupPluginQuarantineRefresh", () => {
  it("maps active payload failures into refreshed plugin quarantine", () => {
    const result = mapStartupPluginQuarantineRefresh({
      cfg: {
        gateway: { mode: "local", port: 19091 },
        plugins: { entries: { discord: { enabled: true } } },
      },
      failures: [
        {
          pluginId: "discord",
          installPath: "/plugins/discord",
          reason: "missing-main-entry",
          detail: "index.js",
        },
      ],
    });

    expect(result.blockingDiagnostic).toBeNull();
    expect(result.quarantinedPlugins).toMatchObject([
      {
        pluginId: "discord",
        state: "configured-unavailable",
        diagnostic: { reason: "missing-main-entry" },
      },
    ]);
  });

  it("maps active ownerless payload failures into blocking diagnostics", () => {
    const result = mapStartupPluginQuarantineRefresh({
      cfg: {
        gateway: { mode: "local", port: 19091 },
        plugins: { entries: { discord: { enabled: true } } },
      },
      failures: [
        {
          pluginId: "discord",
          reason: "missing-install-path",
          detail: "Install path is missing from the plugin install record.",
        },
      ],
    });

    expect(result.quarantinedPlugins).toEqual([]);
    expect(result.blockingDiagnostic?.messages).toEqual([
      expect.stringContaining("Install path is missing from the plugin install record."),
    ]);
  });
});
