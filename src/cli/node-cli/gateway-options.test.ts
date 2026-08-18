import { describe, expect, it } from "vitest";
import { encodePairingSetupCode } from "../../pairing/setup-code.js";
import { resolveNodeGatewayOptions, resolveNodePairGatewayOptions } from "./gateway-options.js";

const TLS_FINGERPRINT = "ab".repeat(32);

describe("node gateway options", () => {
  it("preserves ordered pairing endpoint candidates and pins only the direct endpoint", () => {
    const pair = resolveNodePairGatewayOptions(
      encodePairingSetupCode({
        url: "wss://192.168.1.20:8443/openclaw-gw",
        urls: ["wss://192.168.1.20:8443/openclaw-gw", "wss://gateway.tailnet.example/tailnet-gw"],
        bootstrapToken: "bootstrap-123",
        tlsFingerprint: `sha256:${TLS_FINGERPRINT.toUpperCase()}`,
      }),
    );

    expect(resolveNodeGatewayOptions({}, null, pair).gatewayCandidates).toEqual([
      {
        host: "192.168.1.20",
        port: 8443,
        contextPath: "/openclaw-gw",
        tls: true,
        tlsFingerprint: TLS_FINGERPRINT,
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

  it("canonicalizes explicit TLS pins and rejects invalid values", () => {
    const colonFingerprint = (TLS_FINGERPRINT.match(/.{2}/gu)?.join(":") ?? "").toUpperCase();
    expect(
      resolveNodeGatewayOptions({ tlsFingerprint: `SHA256:${colonFingerprint}` }, null),
    ).toMatchObject({ tls: true, tlsFingerprint: TLS_FINGERPRINT });
    expect(() => resolveNodeGatewayOptions({ tlsFingerprint: "abc123" }, null)).toThrow(
      "Invalid TLS fingerprint",
    );
  });

  it("treats an empty --tls-fingerprint as unset instead of disabling pinning", () => {
    const config = {
      gateway: { tlsFingerprint: TLS_FINGERPRINT },
    } as Parameters<typeof resolveNodeGatewayOptions>[1];
    expect(resolveNodeGatewayOptions({ tlsFingerprint: "" }, config)).toMatchObject({
      tls: true,
      tlsFingerprint: TLS_FINGERPRINT,
    });
    expect(resolveNodeGatewayOptions({ tlsFingerprint: "   " }, config)).toMatchObject({
      tls: true,
      tlsFingerprint: TLS_FINGERPRINT,
    });
  });
});
