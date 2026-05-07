import { describe, expect, it } from "vitest";
import { resolveHostedPluginSurfaceUrl } from "./hosted-plugin-surface-url.js";

describe("resolveHostedPluginSurfaceUrl", () => {
  it("prefers forwarded host over request host", () => {
    expect(
      resolveHostedPluginSurfaceUrl({
        port: 18789,
        requestHost: "10.0.0.2:18789",
        forwardedHost: "gateway.example.com",
        forwardedProto: "https",
      }),
    ).toBe("https://gateway.example.com:443");
  });

  it("keeps forwarded host ports when present", () => {
    expect(
      resolveHostedPluginSurfaceUrl({
        port: 18789,
        requestHost: "10.0.0.2:18789",
        forwardedHost: "gateway.example.com:9443",
        forwardedProto: "https",
      }),
    ).toBe("https://gateway.example.com:9443");
  });
});
