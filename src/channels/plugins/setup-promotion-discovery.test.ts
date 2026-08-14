// Setup promotion discovery tests cover the doctor-only composed surface resolver.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const resolveReadOnlyChannelPluginsForConfigMock = vi.hoisted(() => vi.fn());
const resolveBundledChannelSetupPromotionSurfaceMock = vi.hoisted(() => vi.fn());

vi.mock("./read-only.js", () => ({
  resolveReadOnlyChannelPluginsForConfig: resolveReadOnlyChannelPluginsForConfigMock,
}));

vi.mock("./setup-promotion-bundled.js", () => ({
  resolveBundledChannelSetupPromotionSurface: resolveBundledChannelSetupPromotionSurfaceMock,
}));

import { createDiscoveredChannelSetupPromotionSurfaceResolver } from "./setup-promotion-discovery.js";

const cfg = { channels: { mattermost: { enabled: true } } } as OpenClawConfig;

describe("setup promotion discovery", () => {
  beforeEach(() => {
    resolveReadOnlyChannelPluginsForConfigMock.mockReset();
    resolveReadOnlyChannelPluginsForConfigMock.mockReturnValue({ plugins: [] });
    resolveBundledChannelSetupPromotionSurfaceMock.mockReset();
    resolveBundledChannelSetupPromotionSurfaceMock.mockReturnValue(null);
  });

  it("resolves an external installed plugin promotion surface from its setup contract", () => {
    resolveReadOnlyChannelPluginsForConfigMock.mockReturnValue({
      plugins: [
        {
          id: "mattermost",
          setupContract: { singleAccountKeysToMove: ["botToken", "baseUrl"] },
        },
      ],
    });

    const resolve = createDiscoveredChannelSetupPromotionSurfaceResolver(cfg);

    expect(resolve("mattermost")).toEqual({
      singleAccountKeysToMove: ["botToken", "baseUrl"],
    });
    expect(resolveBundledChannelSetupPromotionSurfaceMock).not.toHaveBeenCalled();
  });

  it("prefers the setup contract over the deprecated setup adapter", () => {
    resolveReadOnlyChannelPluginsForConfigMock.mockReturnValue({
      plugins: [
        {
          id: "mattermost",
          setupContract: { singleAccountKeysToMove: ["botToken", "baseUrl"] },
          setup: { singleAccountKeysToMove: ["legacyKey"] },
        },
      ],
    });

    const resolve = createDiscoveredChannelSetupPromotionSurfaceResolver(cfg);

    expect(resolve("mattermost")).toEqual({
      singleAccountKeysToMove: ["botToken", "baseUrl"],
    });
  });

  it("falls back to the deprecated setup adapter when no setup contract exists", () => {
    resolveReadOnlyChannelPluginsForConfigMock.mockReturnValue({
      plugins: [
        {
          id: "mattermost",
          setup: { singleAccountKeysToMove: ["botToken", "baseUrl"] },
        },
      ],
    });

    const resolve = createDiscoveredChannelSetupPromotionSurfaceResolver(cfg);

    expect(resolve("mattermost")).toEqual({
      singleAccountKeysToMove: ["botToken", "baseUrl"],
    });
  });

  it("ignores plugins without a setup adapter surface", () => {
    resolveReadOnlyChannelPluginsForConfigMock.mockReturnValue({
      plugins: [{ id: "demo" }],
    });

    const resolve = createDiscoveredChannelSetupPromotionSurfaceResolver(cfg);

    expect(resolve("demo")).toBeNull();
    expect(resolveBundledChannelSetupPromotionSurfaceMock).toHaveBeenCalledWith("demo");
  });

  it("keeps an installed plugin surface authoritative when it declares no promotion keys", () => {
    resolveReadOnlyChannelPluginsForConfigMock.mockReturnValue({
      plugins: [{ id: "mattermost", setupContract: { resolveAccountId: () => "default" } }],
    });
    resolveBundledChannelSetupPromotionSurfaceMock.mockReturnValue({
      singleAccountKeysToMove: ["bundledKey"],
    });

    const resolve = createDiscoveredChannelSetupPromotionSurfaceResolver(cfg);

    expect(resolve("mattermost")).toEqual({ resolveAccountId: expect.any(Function) });
    expect(resolveBundledChannelSetupPromotionSurfaceMock).not.toHaveBeenCalled();
  });

  it("falls back to the bundled lookup when read-only discovery has no entry", () => {
    resolveBundledChannelSetupPromotionSurfaceMock.mockReturnValue({
      singleAccountKeysToMove: ["bundledKey"],
    });

    const resolve = createDiscoveredChannelSetupPromotionSurfaceResolver(cfg);

    expect(resolve("signal")).toEqual({ singleAccountKeysToMove: ["bundledKey"] });
  });

  it("falls back to the bundled lookup when read-only discovery fails", () => {
    resolveReadOnlyChannelPluginsForConfigMock.mockImplementation(() => {
      throw new Error("snapshot unavailable");
    });
    resolveBundledChannelSetupPromotionSurfaceMock.mockReturnValue(null);

    const resolve = createDiscoveredChannelSetupPromotionSurfaceResolver(cfg);

    expect(resolve("mattermost")).toBeNull();
    expect(resolveBundledChannelSetupPromotionSurfaceMock).toHaveBeenCalledWith("mattermost");
  });

  it("resolves read-only plugins lazily and only once", () => {
    const resolve = createDiscoveredChannelSetupPromotionSurfaceResolver(cfg);

    expect(resolveReadOnlyChannelPluginsForConfigMock).not.toHaveBeenCalled();

    resolve("mattermost");
    resolve("signal");

    expect(resolveReadOnlyChannelPluginsForConfigMock).toHaveBeenCalledTimes(1);
    expect(resolveReadOnlyChannelPluginsForConfigMock).toHaveBeenCalledWith(cfg, {
      includePersistedAuthState: false,
      includeSetupFallbackPlugins: true,
    });
  });
});
