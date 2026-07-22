// Verifies security audit collector discovery across live plugin registries.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import {
  pinActivePluginHttpRouteRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { runSecurityAudit } from "./audit.js";

describe("security audit live plugin collectors", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("runs collectors from pinned live registries while active duplicates win", async () => {
    const activeDuplicateCollector = vi.fn(() => [
      {
        checkId: "plugins.duplicate.active",
        severity: "warn" as const,
        title: "Active duplicate collector ran",
        detail: "active duplicate",
      },
    ]);
    const pinnedDuplicateCollector = vi.fn(() => [
      {
        checkId: "plugins.duplicate.pinned",
        severity: "warn" as const,
        title: "Pinned duplicate collector ran",
        detail: "pinned duplicate",
      },
    ]);
    const pinnedOnlyCollector = vi.fn(() => [
      {
        checkId: "plugins.pinned_only.audit",
        severity: "warn" as const,
        title: "Pinned-only collector ran",
        detail: "pinned only",
      },
    ]);

    const startupRegistry = createEmptyPluginRegistry();
    startupRegistry.securityAuditCollectors.push(
      {
        pluginId: "duplicate-plugin",
        pluginName: "Duplicate plugin",
        collector: pinnedDuplicateCollector,
        source: "runtime",
      },
      {
        pluginId: "pinned-only-plugin",
        pluginName: "Pinned-only plugin",
        collector: pinnedOnlyCollector,
        source: "runtime",
      },
    );
    const activeRegistry = createEmptyPluginRegistry();
    activeRegistry.securityAuditCollectors.push({
      pluginId: "duplicate-plugin",
      pluginName: "Duplicate plugin",
      collector: activeDuplicateCollector,
      source: "runtime",
    });

    setActivePluginRegistry(startupRegistry);
    pinActivePluginHttpRouteRegistry(startupRegistry);
    setActivePluginRegistry(activeRegistry);

    const report = await runSecurityAudit({
      config: {},
      sourceConfig: {},
      env: {},
      platform: process.platform,
      includeFilesystem: false,
      includeChannelSecurity: false,
      deep: false,
      stateDir: "/tmp/openclaw-test-state",
      configPath: "/tmp/openclaw-test-config.json",
      plugins: [],
      loadPluginSecurityCollectors: true,
      configSnapshot: null,
    });

    const pluginCheckIds = report.findings
      .map((finding) => finding.checkId)
      .filter((checkId) => checkId.startsWith("plugins."))
      .toSorted();
    expect(pluginCheckIds).toStrictEqual(["plugins.duplicate.active", "plugins.pinned_only.audit"]);
    expect(activeDuplicateCollector).toHaveBeenCalledOnce();
    expect(pinnedDuplicateCollector).not.toHaveBeenCalled();
    expect(pinnedOnlyCollector).toHaveBeenCalledOnce();
  });
});
