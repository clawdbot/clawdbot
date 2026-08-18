import { describe, expect, it } from "vitest";
import { canSkipGatewayConfigLoad } from "./explicit-connection-policy.js";

describe("canSkipGatewayConfigLoad", () => {
  const explicitAuth = { token: "t" };

  it("skips config IO for a plaintext loopback target with explicit auth", () => {
    expect(canSkipGatewayConfigLoad({ urlOverride: "ws://127.0.0.1:18789", explicitAuth })).toBe(
      true,
    );
  });

  it("loads config for a wss target so configured edge auth is not dropped", () => {
    expect(canSkipGatewayConfigLoad({ urlOverride: "wss://gateway.example", explicitAuth })).toBe(
      false,
    );
  });

  it("loads config for an https session URL target", () => {
    expect(
      canSkipGatewayConfigLoad({ urlOverride: "https://gateway.example/chat/main", explicitAuth }),
    ).toBe(false);
  });

  it("never skips without a url or without explicit auth", () => {
    expect(canSkipGatewayConfigLoad({ explicitAuth })).toBe(false);
    expect(canSkipGatewayConfigLoad({ urlOverride: "ws://127.0.0.1:18789" })).toBe(false);
  });

  it("never skips when a config was already supplied", () => {
    expect(
      canSkipGatewayConfigLoad({ config: {}, urlOverride: "ws://127.0.0.1:18789", explicitAuth }),
    ).toBe(false);
  });
});
