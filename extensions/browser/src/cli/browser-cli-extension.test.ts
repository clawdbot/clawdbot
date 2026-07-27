import { describe, expect, it } from "vitest";
import { resolveLocalPairingGatewayUrl } from "./browser-cli-extension-pairing.js";

describe("browser extension pairing Gateway URL", () => {
  it("uses loopback only for a plaintext local Gateway", () => {
    expect(resolveLocalPairingGatewayUrl({ gatewayPort: 18789, tlsEnabled: false })).toBe(
      "ws://127.0.0.1:18789",
    );
  });

  it("requires the certificate hostname for a TLS Gateway", () => {
    expect(() => resolveLocalPairingGatewayUrl({ gatewayPort: 18789, tlsEnabled: true })).toThrow(
      "--gateway-url wss://<certificate-host>",
    );
    expect(
      resolveLocalPairingGatewayUrl({
        configuredRemote: "wss://gateway.example",
        gatewayPort: 18789,
        tlsEnabled: true,
      }),
    ).toBe("wss://gateway.example");
  });
});
