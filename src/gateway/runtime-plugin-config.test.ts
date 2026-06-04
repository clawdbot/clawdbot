/**
 * Runtime plugin config regression tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  applyPluginAutoEnable: vi.fn(),
  getCurrentPluginMetadataSnapshot: vi.fn(),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: mocks.getCurrentPluginMetadataSnapshot,
}));

describe("resolveGatewayPluginConfig", () => {
  beforeEach(() => {
    mocks.applyPluginAutoEnable.mockReset();
    mocks.getCurrentPluginMetadataSnapshot.mockReset();
  });

  it("reuses auto-enabled config for the same runtime config and metadata snapshot", async () => {
    const { resolveGatewayPluginConfig } = await import("./runtime-plugin-config.js");
    const config = { channels: { telegram: { botToken: "token" } } } as OpenClawConfig;
    const snapshot = { manifestRegistry: { plugins: [], diagnostics: [] } };
    const resolved = { ...config, plugins: { allow: ["telegram"] } } as OpenClawConfig;
    mocks.getCurrentPluginMetadataSnapshot.mockReturnValue(snapshot);
    mocks.applyPluginAutoEnable.mockReturnValue({ config: resolved, changes: [] });

    expect(resolveGatewayPluginConfig({ config })).toBe(resolved);
    expect(resolveGatewayPluginConfig({ config })).toBe(resolved);

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledTimes(1);
  });

  it("refreshes the cached config when metadata snapshot changes", async () => {
    const { resolveGatewayPluginConfig } = await import("./runtime-plugin-config.js");
    const config = { channels: { telegram: { botToken: "token" } } } as OpenClawConfig;
    const first = { manifestRegistry: { plugins: [], diagnostics: [] } };
    const second = { manifestRegistry: { plugins: [], diagnostics: [] } };
    mocks.getCurrentPluginMetadataSnapshot.mockReturnValueOnce(first).mockReturnValue(second);
    mocks.applyPluginAutoEnable
      .mockReturnValueOnce({ config: { ...config, first: true }, changes: [] })
      .mockReturnValueOnce({ config: { ...config, second: true }, changes: [] });

    expect(resolveGatewayPluginConfig({ config })).toMatchObject({ first: true });
    expect(resolveGatewayPluginConfig({ config })).toMatchObject({ second: true });

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledTimes(2);
  });

  it("does not cache without a current metadata snapshot", async () => {
    const { resolveGatewayPluginConfig } = await import("./runtime-plugin-config.js");
    const config = {} as OpenClawConfig;
    mocks.getCurrentPluginMetadataSnapshot.mockReturnValue(undefined);
    mocks.applyPluginAutoEnable.mockImplementation(() => ({ config: {}, changes: [] }));

    resolveGatewayPluginConfig({ config });
    resolveGatewayPluginConfig({ config });

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledTimes(2);
  });
});
