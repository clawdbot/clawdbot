// Runtime registry loader tests cover the surviving process-root load scopes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadOpenClawPlugins: vi.fn<typeof import("../loader.js").loadOpenClawPlugins>(),
  resolveConfiguredChannelPluginIds:
    vi.fn<typeof import("../channel-plugin-ids.js").resolveConfiguredChannelPluginIds>(),
  resolveChannelPluginIds:
    vi.fn<typeof import("../channel-plugin-ids.js").resolveChannelPluginIds>(),
  resolveEffectivePluginIds:
    vi.fn<typeof import("../effective-plugin-ids.js").resolveEffectivePluginIds>(),
  applyPluginAutoEnable:
    vi.fn<typeof import("../../config/plugin-auto-enable.js").applyPluginAutoEnable>(),
  resolvePluginMetadataSnapshot:
    vi.fn<typeof import("../plugin-metadata-snapshot.js").resolvePluginMetadataSnapshot>(),
  resolveAgentWorkspaceDir: vi.fn<
    typeof import("../../agents/agent-scope.js").resolveAgentWorkspaceDir
  >(() => "/resolved-workspace"),
  resolveDefaultAgentId: vi.fn<typeof import("../../agents/agent-scope.js").resolveDefaultAgentId>(
    () => "default",
  ),
}));

vi.mock("../loader.js", () => ({
  loadOpenClawPlugins: (...args: Parameters<typeof mocks.loadOpenClawPlugins>) =>
    mocks.loadOpenClawPlugins(...args),
}));

vi.mock("../channel-plugin-ids.js", () => ({
  resolveConfiguredChannelPluginIds: (
    ...args: Parameters<typeof mocks.resolveConfiguredChannelPluginIds>
  ) => mocks.resolveConfiguredChannelPluginIds(...args),
  resolveChannelPluginIds: (...args: Parameters<typeof mocks.resolveChannelPluginIds>) =>
    mocks.resolveChannelPluginIds(...args),
}));

vi.mock("../effective-plugin-ids.js", () => ({
  resolveEffectivePluginIds: (...args: Parameters<typeof mocks.resolveEffectivePluginIds>) =>
    mocks.resolveEffectivePluginIds(...args),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: Parameters<typeof mocks.applyPluginAutoEnable>) =>
    mocks.applyPluginAutoEnable(...args),
}));

vi.mock("../plugin-metadata-snapshot.js", () => ({
  resolvePluginMetadataSnapshot: (
    ...args: Parameters<typeof mocks.resolvePluginMetadataSnapshot>
  ) => mocks.resolvePluginMetadataSnapshot(...args),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: (...args: Parameters<typeof mocks.resolveAgentWorkspaceDir>) =>
    mocks.resolveAgentWorkspaceDir(...args),
  resolveDefaultAgentId: (...args: Parameters<typeof mocks.resolveDefaultAgentId>) =>
    mocks.resolveDefaultAgentId(...args),
}));

import { ensurePluginRegistryLoaded } from "./runtime-registry-loader.js";

function requireLoadOptions(): Record<string, unknown> {
  const options = mocks.loadOpenClawPlugins.mock.calls[0]?.[0];
  if (!options) {
    throw new Error("expected plugin load options");
  }
  return options as Record<string, unknown>;
}

describe("ensurePluginRegistryLoaded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.applyPluginAutoEnable.mockImplementation((params) => ({
      config: params.config ?? {},
      changes: [],
      autoEnabledReasons: {},
    }));
  });

  it("loads configured channel owners through the canonical root loader", () => {
    const config = { channels: { demo: { enabled: true } } };
    mocks.resolveConfiguredChannelPluginIds.mockReturnValue(["demo-channel"]);

    ensurePluginRegistryLoaded({ scope: "configured-channels", config: config as never });

    expect(mocks.resolveConfiguredChannelPluginIds).toHaveBeenCalledWith(
      expect.objectContaining({ config, workspaceDir: "/resolved-workspace" }),
    );
    expect(requireLoadOptions()).toEqual(
      expect.objectContaining({
        onlyPluginIds: ["demo-channel"],
        throwOnLoadError: true,
        workspaceDir: "/resolved-workspace",
      }),
    );
  });

  it("keeps an empty configured-channel scope empty", () => {
    mocks.resolveConfiguredChannelPluginIds.mockReturnValue([]);

    ensurePluginRegistryLoaded({ scope: "configured-channels", config: {} });

    expect(requireLoadOptions().onlyPluginIds).toEqual([]);
  });

  it("loads effective plugin ids for the all scope", () => {
    const config = { plugins: { enabled: true } };
    mocks.resolveEffectivePluginIds.mockReturnValue(["demo", "memory-core"]);

    ensurePluginRegistryLoaded({ scope: "all", config });

    expect(mocks.resolveEffectivePluginIds).toHaveBeenCalledWith({
      config,
      env: process.env,
      workspaceDir: "/resolved-workspace",
    });
    expect(requireLoadOptions()).toEqual(
      expect.objectContaining({
        onlyPluginIds: ["demo", "memory-core"],
        throwOnLoadError: true,
      }),
    );
  });
});
