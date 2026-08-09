import { describe, expect, it } from "vitest";
import { encodePairingSetupCode } from "../../pairing/setup-code.js";
import { resolveNodeGatewayOptions, resolveNodePairGatewayOptions } from "./gateway-options.js";

describe("node gateway options", () => {
  it("preserves ordered pairing endpoint candidates and pins only the direct endpoint", () => {
    const pair = resolveNodePairGatewayOptions(
      encodePairingSetupCode({
        url: "wss://192.168.1.20:8443/openclaw-gw",
        urls: ["wss://192.168.1.20:8443/openclaw-gw", "wss://gateway.tailnet.example/tailnet-gw"],
        bootstrapToken: "bootstrap-123",
        tlsFingerprint: "sha256:direct-leaf",
      }),
    );

    expect(resolveNodeGatewayOptions({}, null, pair).gatewayCandidates).toEqual([
      {
        host: "192.168.1.20",
        port: 8443,
        contextPath: "/openclaw-gw",
        tls: true,
        tlsFingerprint: "sha256:direct-leaf",
      },
      {
        host: "gateway.tailnet.example",
        port: 443,
        contextPath: "/tailnet-gw",
        tls: true,
      },
    ]);
    expect(resolveNodeGatewayOptions({}, null, pair).contextPath).toBe("/openclaw-gw");
  });

  it("keeps origin-only pairing endpoints pathless", () => {
    const pair = resolveNodePairGatewayOptions(
      encodePairingSetupCode({
        url: "wss://gateway.example",
        bootstrapToken: "bootstrap-123",
      }),
    );

    expect(resolveNodeGatewayOptions({}, null, pair)).toMatchObject({
      contextPath: undefined,
      gatewayCandidates: [{ host: "gateway.example", port: 443, tls: true }],
    });
  });

  it("collapses pairing candidates when an endpoint flag is explicit", () => {
    const pair = resolveNodePairGatewayOptions(
      encodePairingSetupCode({
        url: "ws://192.168.1.20:18789",
        urls: ["ws://192.168.1.20:18789", "wss://gateway.tailnet.example"],
        bootstrapToken: "bootstrap-123",
      }),
    );

    expect(resolveNodeGatewayOptions({ host: "manual.example" }, null, pair)).toMatchObject({
      host: "manual.example",
      gatewayCandidates: undefined,
    });
  });
});
