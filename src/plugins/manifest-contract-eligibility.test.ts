import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPluginMetadataSnapshot: vi.fn(),
  loadPluginMetadataSnapshot: vi.fn(),
}));

vi.mock("./current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: mocks.getCurrentPluginMetadataSnapshot,
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
}));

import { loadManifestContractSnapshot } from "./manifest-contract-eligibility.js";

describe("loadManifestContractSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPluginMetadataSnapshot.mockReturnValue(undefined);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      plugins: [],
    });
  });

  it("checks the current metadata snapshot with env and workspace scope", () => {
    const env = { HOME: "/home/snapshot" } as NodeJS.ProcessEnv;
    const current = {
      index: { plugins: [] },
      plugins: [],
    };
    mocks.getCurrentPluginMetadataSnapshot.mockReturnValue(current);

    expect(loadManifestContractSnapshot({ config: {}, workspaceDir: "/workspace", env })).toEqual({
      index: current.index,
      plugins: current.plugins,
    });

    expect(mocks.getCurrentPluginMetadataSnapshot).toHaveBeenCalledWith({
      config: {},
      env,
      workspaceDir: "/workspace",
    });
    expect(mocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("falls back to the shared metadata snapshot loader", () => {
    const env = { HOME: "/home/fallback" } as NodeJS.ProcessEnv;
    const snapshot = {
      index: { plugins: [{ pluginId: "demo" }] },
      plugins: [{ id: "demo" }],
    };
    mocks.loadPluginMetadataSnapshot.mockReturnValue(snapshot);

    expect(loadManifestContractSnapshot({ config: {}, env })).toEqual({
      index: snapshot.index,
      plugins: snapshot.plugins,
    });

    expect(mocks.loadPluginMetadataSnapshot).toHaveBeenCalledWith({
      config: {},
      env,
    });
  });
});
