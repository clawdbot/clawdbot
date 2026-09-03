import { describe, expect, it, vi } from "vitest";
// Successor probe target resolution for the Windows scheduled-task handoff.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { testing } from "./run.test-support.js";

const loadGatewayTlsServerRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock("../../infra/tls/gateway.js", () => ({
  loadGatewayTlsServerRuntime: loadGatewayTlsServerRuntimeMock,
}));

function tlsConfig(enabled: boolean): OpenClawConfig {
  return {
    gateway: { tls: { enabled } },
  } as unknown as OpenClawConfig;
}

describe("successor probe target resolution", () => {
  it("probes plain-HTTP successors on loopback for wildcard bind hosts", async () => {
    // gateway.bind: lan resolves to 0.0.0.0; the canonical local probe's
    // wildcard normalization must steer the handoff probe to 127.0.0.1.
    const resolve = testing.createSuccessorProbeTargetResolver(tlsConfig(false));

    await expect(resolve({ host: "0.0.0.0", port: 18789 })).resolves.toEqual({
      transport: "http",
      host: "127.0.0.1",
      port: 18789,
    });
  });

  it("probes TLS successors over HTTPS with the configured certificate pin", async () => {
    const fingerprintSha256 = "b".repeat(64);
    loadGatewayTlsServerRuntimeMock.mockResolvedValueOnce({ fingerprintSha256 });
    const resolve = testing.createSuccessorProbeTargetResolver(tlsConfig(true));

    await expect(resolve({ host: "0.0.0.0", port: 18789 })).resolves.toEqual({
      transport: "https",
      host: "127.0.0.1",
      port: 18789,
      fingerprintSha256,
    });
    expect(loadGatewayTlsServerRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, autoGenerate: false }),
    );
  });

  it("leaves verification explicitly unavailable when the TLS pin cannot be resolved", async () => {
    // A TLS gateway whose certificate pin is unresolvable must never be probed
    // over plaintext: the outcome records the unverified reason instead of
    // falsely failing a healthy successor.
    loadGatewayTlsServerRuntimeMock.mockResolvedValueOnce({ fingerprintSha256: "" });
    const resolve = testing.createSuccessorProbeTargetResolver(tlsConfig(true));

    await expect(resolve({ host: "127.0.0.1", port: 18789 })).resolves.toEqual({
      transport: "unverified",
      reason: "tls-certificate-pin-unavailable",
    });
  });

  it("treats a TLS runtime failure as an unavailable pin rather than an HTTP probe", async () => {
    loadGatewayTlsServerRuntimeMock.mockRejectedValueOnce(new Error("cert unreadable"));
    const resolve = testing.createSuccessorProbeTargetResolver(tlsConfig(true));

    await expect(resolve({ host: "127.0.0.1", port: 18789 })).resolves.toEqual({
      transport: "unverified",
      reason: "tls-certificate-pin-unavailable",
    });
  });
});
