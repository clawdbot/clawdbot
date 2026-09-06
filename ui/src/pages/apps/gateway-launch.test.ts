import { describe, expect, it } from "vitest";
import { buildMacGatewayLaunchUrl } from "./gateway-launch.ts";

describe("buildMacGatewayLaunchUrl", () => {
  it.each([
    ["wss://gateway.example", undefined, "https://gateway.example/"],
    [
      "wss://other.example:8443/openclaw%20gateway",
      undefined,
      "https://other.example:8443/openclaw%20gateway",
    ],
    [
      "ws://127.0.0.1:18789",
      "https://identity.example/operator/",
      "https://identity.example/operator/",
    ],
    ["wss://gateway.example/operator%2Fteam", undefined, "https://gateway.example/operator%2Fteam"],
  ])("preserves the current gateway address %s", (gateway, identity, expected) => {
    const result = new URL(buildMacGatewayLaunchUrl(gateway, identity)!);
    expect(result.protocol).toBe("openclaw:");
    expect(result.host).toBe("gateway");
    expect(result.pathname).toBe("/add");
    expect([...result.searchParams]).toEqual([["url", expected]]);
  });

  it.each([
    "https://user@gateway.example/",
    "https://gateway.example/?token=secret",
    "https://gateway.example/#token=secret",
    "https://gateway.example/?",
    "https://gateway.example/#",
    "http://gateway.example/",
    "ws://127.0.0.1:18789",
    "javascript:alert(1)",
    "not a URL",
  ])("does not launch unsupported or credential-bearing address %s", (url) => {
    expect(buildMacGatewayLaunchUrl(url)).toBeNull();
    expect(buildMacGatewayLaunchUrl("wss://gateway.example", url)).toBeNull();
  });

  it("rejects URL password credentials", () => {
    const address = new URL("https://gateway.example/");
    address.username = "fixture-user";
    address.password = "fixture-password";
    expect(buildMacGatewayLaunchUrl(address.href)).toBeNull();
    expect(buildMacGatewayLaunchUrl("wss://gateway.example", address.href)).toBeNull();
  });
});
