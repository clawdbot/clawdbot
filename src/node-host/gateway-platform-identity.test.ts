import { describe, expect, it, vi } from "vitest";
import { resolveNodeHostGatewayPlatformIdentity } from "./gateway-platform-identity.js";

describe("resolveNodeHostGatewayPlatformIdentity", () => {
  it.each([
    { runtime: "darwin", platform: "macos", deviceFamily: "Mac", modelIdentifier: "Mac16,1" },
    { runtime: "linux", platform: "linux", deviceFamily: "Linux", modelIdentifier: "Test Board" },
    { runtime: "win32", platform: "windows", deviceFamily: "Windows", modelIdentifier: undefined },
    {
      runtime: "freebsd",
      platform: "unknown",
      deviceFamily: undefined,
      modelIdentifier: undefined,
    },
  ] as const)(
    "reports $runtime hardware identity",
    ({ runtime, platform, deviceFamily, modelIdentifier }) => {
      const resolveModel = vi.fn(() => modelIdentifier);
      expect(resolveNodeHostGatewayPlatformIdentity(runtime, resolveModel)).toEqual({
        platform,
        ...(deviceFamily ? { deviceFamily, modelIdentifier } : {}),
      });
      expect(resolveModel).toHaveBeenCalledExactlyOnceWith(runtime);
    },
  );
});
