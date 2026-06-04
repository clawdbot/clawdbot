// Covers manifest contract eligibility decisions.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPluginMetadataSnapshot: vi.fn(),
  resolvePluginMetadataSnapshot: vi.fn(),
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
}));

import { loadManifestContractSnapshot } from "./manifest-contract-eligibility.js";

describe("loadManifestContractSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      plugins: [],
    });
    mocks.resolvePluginMetadataSnapshot.mockImplementation(
      (params?: Parameters<typeof mocks.loadPluginMetadataSnapshot>[0]) =>
        mocks.loadPluginMetadataSnapshot(params),
    );
  });

  it("resolves metadata with env and workspace scope", () => {
    const env = { HOME: "/home/snapshot" } as NodeJS.ProcessEnv;
    const snapshot = {
      index: { plugins: [] },
      plugins: [],
    };
    mocks.resolvePluginMetadataSnapshot.mockReturnValue(snapshot);

    expect(loadManifestContractSnapshot({ config: {}, workspaceDir: "/workspace", env })).toEqual({
      index: snapshot.index,
      plugins: snapshot.plugins,
    });

    expect(mocks.resolvePluginMetadataSnapshot).toHaveBeenCalledWith({
      config: {},
      env,
      workspaceDir: "/workspace",
      allowWorkspaceScopedCurrent: false,
    });
    expect(mocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("opts unscoped callers into the stored workspace-scoped snapshot", () => {
    const env = { HOME: "/home/snapshot" } as NodeJS.ProcessEnv;
    const snapshot = {
      index: { plugins: [] },
      plugins: [],
    };
    mocks.resolvePluginMetadataSnapshot.mockReturnValue(snapshot);

    expect(loadManifestContractSnapshot({ config: {}, env })).toEqual({
      index: snapshot.index,
      plugins: snapshot.plugins,
    });

    expect(mocks.resolvePluginMetadataSnapshot).toHaveBeenCalledWith({
      config: {},
      env,
      allowWorkspaceScopedCurrent: true,
    });
    expect(mocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("normalizes omitted config before checking unscoped snapshot compatibility", () => {
    const env = { HOME: "/home/default-config" } as NodeJS.ProcessEnv;
    const snapshot = {
      index: { plugins: [{ pluginId: "demo" }] },
      plugins: [{ id: "demo" }],
    };
    mocks.loadPluginMetadataSnapshot.mockReturnValue(snapshot);

    expect(loadManifestContractSnapshot({ env })).toEqual({
      index: snapshot.index,
      plugins: snapshot.plugins,
    });

    expect(mocks.resolvePluginMetadataSnapshot).toHaveBeenCalledWith({
      config: {},
      env,
      allowWorkspaceScopedCurrent: true,
    });
    expect(mocks.loadPluginMetadataSnapshot).toHaveBeenCalledWith({
      config: {},
      env,
      allowWorkspaceScopedCurrent: true,
    });
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
      allowWorkspaceScopedCurrent: true,
    });
  });
});
