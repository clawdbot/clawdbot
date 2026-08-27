// Covers plugin gateway auth bypass caching across metadata lifecycle resets.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { getCachedPluginGatewayAuthBypassPaths } from "./server-http-plugin-auth.js";

const resolveBypassPaths = vi.hoisted(() =>
  vi.fn<(params: { channelId: string; cfg: OpenClawConfig }) => Promise<string[]>>(),
);

vi.mock("../channels/plugins/gateway-auth-bypass.js", () => ({
  resolveBundledChannelGatewayAuthBypassPaths: resolveBypassPaths,
}));

describe("getCachedPluginGatewayAuthBypassPaths", () => {
  beforeEach(() => {
    resolveBypassPaths.mockReset();
    clearPluginMetadataLifecycleCaches();
  });

  it("caches resolved bypass paths per config identity", async () => {
    const config: OpenClawConfig = { channels: { telegram: {} } };
    resolveBypassPaths.mockResolvedValue(["/telegram/webhook"]);

    await expect(getCachedPluginGatewayAuthBypassPaths(config)).resolves.toEqual(
      new Set(["/telegram/webhook"]),
    );
    await getCachedPluginGatewayAuthBypassPaths(config);
    expect(resolveBypassPaths).toHaveBeenCalledTimes(1);
  });

  it("drops cached bypass paths on a metadata lifecycle reset despite stable config identity", async () => {
    const config: OpenClawConfig = { channels: { telegram: {} } };
    resolveBypassPaths.mockResolvedValueOnce(["/telegram/old-bypass"]);
    await expect(getCachedPluginGatewayAuthBypassPaths(config)).resolves.toEqual(
      new Set(["/telegram/old-bypass"]),
    );

    // Same config object, replaced plugin contract: the reset must invalidate,
    // or the predecessor's unauthenticated paths keep bypassing gateway auth.
    clearPluginMetadataLifecycleCaches();
    resolveBypassPaths.mockResolvedValueOnce(["/telegram/new-bypass"]);

    await expect(getCachedPluginGatewayAuthBypassPaths(config)).resolves.toEqual(
      new Set(["/telegram/new-bypass"]),
    );
  });

  it("retries after a failed resolution instead of caching the rejection", async () => {
    const config: OpenClawConfig = { channels: { telegram: {} } };
    resolveBypassPaths.mockRejectedValueOnce(new Error("resolution failed"));
    await expect(getCachedPluginGatewayAuthBypassPaths(config)).rejects.toThrow(
      "resolution failed",
    );

    resolveBypassPaths.mockResolvedValueOnce(["/telegram/webhook"]);
    await expect(getCachedPluginGatewayAuthBypassPaths(config)).resolves.toEqual(
      new Set(["/telegram/webhook"]),
    );
  });

  it("keeps the fresh generation cached when a stale failed resolution settles late", async () => {
    const config: OpenClawConfig = { channels: { telegram: {} } };
    let rejectStale: (error: Error) => void = () => {};
    resolveBypassPaths.mockReturnValueOnce(
      new Promise<string[]>((_resolve, reject) => {
        rejectStale = reject;
      }),
    );
    const stale = getCachedPluginGatewayAuthBypassPaths(config);

    clearPluginMetadataLifecycleCaches();
    resolveBypassPaths.mockResolvedValue(["/telegram/webhook"]);
    await expect(getCachedPluginGatewayAuthBypassPaths(config)).resolves.toEqual(
      new Set(["/telegram/webhook"]),
    );

    rejectStale(new Error("stale plugin generation failed"));
    await expect(stale).rejects.toThrow("stale plugin generation failed");

    // The stale rejection evicts from its own generation only; the fresh entry
    // must stay cached instead of being re-resolved.
    await getCachedPluginGatewayAuthBypassPaths(config);
    expect(resolveBypassPaths).toHaveBeenCalledTimes(2);
  });
});
