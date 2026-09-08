import { describe, expect, it } from "vitest";
import { gatewayCredentialScope, gatewayOriginScope } from "./gateway-origin-scope.js";

describe("gateway origin scope", () => {
  it.each([
    ["wss://Gateway.Example:443/", "wss://gateway.example"],
    ["ws://gateway.example:80/rpc///", "ws://gateway.example/rpc"],
    ["wss://gateway.example/rpc/?token=secret#fragment", "wss://gateway.example/rpc"],
  ])("normalizes token scope %s", (input, expected) => {
    expect(gatewayOriginScope(input)).toBe(expected);
  });

  it("retains search parameters only for browser credential scopes", () => {
    const input = "wss://gateway.example:443/rpc/?account=work#fragment";

    expect(gatewayCredentialScope(input)).toBe("wss://gateway.example/rpc?account=work");
    expect(gatewayOriginScope(input)).toBe("wss://gateway.example/rpc");
  });

  it.each([
    ["", "default"],
    ["  wss://gateway.example/base/  ", "wss://gateway.example/base"],
    ["not a url", "not a url"],
  ])("preserves fallback semantics for %j", (input, expected) => {
    expect(gatewayOriginScope(input)).toBe(expected);
  });
});
