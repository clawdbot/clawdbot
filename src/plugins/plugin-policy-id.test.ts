import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolvePluginActivationDecisionShared } from "./config-activation-shared.js";
import { normalizePluginsConfig } from "./config-state.js";
import { resolveManifestOwnerBasePolicyBlock } from "./manifest-owner-policy.js";
import { loadPluginManifest } from "./manifest.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("mixed-case plugin policy ids", () => {
  it("applies normalized deny, allow, and entry policy to declared ids", () => {
    expect(
      resolveManifestOwnerBasePolicyBlock({
        plugin: { id: "Malicious-Scraper" },
        normalizedConfig: normalizePluginsConfig({ deny: ["malicious-scraper"] }),
      }),
    ).toBe("blocked-by-denylist");
    expect(
      resolveManifestOwnerBasePolicyBlock({
        plugin: { id: "Trusted-Plugin" },
        normalizedConfig: normalizePluginsConfig({ allow: ["trusted-plugin"] }),
      }),
    ).toBeNull();
    expect(
      resolveManifestOwnerBasePolicyBlock({
        plugin: { id: "Sneaky-Plugin" },
        normalizedConfig: normalizePluginsConfig({
          entries: { "sneaky-plugin": { enabled: false } },
        }),
      }),
    ).toBe("plugin-disabled");
  });

  it("blocks a mixed-case id in shared activation policy", () => {
    expect(
      resolvePluginActivationDecisionShared({
        id: "Malicious-Scraper",
        origin: "bundled",
        config: normalizePluginsConfig({ deny: ["malicious-scraper"] }),
        enabledByDefault: true,
        isBundledChannelEnabledByChannelConfig: () => false,
      }),
    ).toMatchObject({ enabled: false, activated: false, cause: "blocked-by-denylist" });
  });

  it("rejects a mixed-case spelling of a core reserved id", () => {
    const dir = tempDirs.make("plugin-id-case-");
    fs.writeFileSync(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify({ id: "Node-MCP", configSchema: { type: "object" } }),
      "utf-8",
    );
    const result = loadPluginManifest(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("reserved by OpenClaw core");
    }
  });
});
