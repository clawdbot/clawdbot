import { describe, expect, it } from "vitest";
import {
  assertGatewayLoopbackLanProof,
  parseGatewayLoopbackLanOptions,
  runGatewayLoopbackLanProof,
  type GatewayLoopbackLanProof,
} from "./gateway-loopback-lan-access.js";

describe("Gateway loopback and LAN access producer", () => {
  it("parses the evidence artifact directory", () => {
    expect(
      parseGatewayLoopbackLanOptions(["--artifact-base", ".artifacts/gateway-network"])
        .artifactBase,
    ).toContain(".artifacts/gateway-network");
    expect(() => parseGatewayLoopbackLanOptions([])).toThrow("--artifact-base is required");
    expect(() => parseGatewayLoopbackLanOptions(["--other", "value"])).toThrow("unknown argument");
  });

  it("rejects incomplete network proof", () => {
    const incomplete: GatewayLoopbackLanProof = {
      loopback: {
        authenticatedHealthRpc: true,
        healthStatus: 200,
        invalidTokenRejected: true,
        isolatedFromLanInterface: false,
      },
      lan: {
        authenticatedHealthRpc: true,
        healthStatus: 200,
        invalidTokenRejected: true,
        nonLoopbackInterface: true,
        reachableThroughInterface: true,
      },
    };
    expect(() => assertGatewayLoopbackLanProof(incomplete)).toThrow("loopback isolation from LAN");
  });

  it("proves real loopback isolation, LAN reachability, and shared-token authentication", async () => {
    const proof = await runGatewayLoopbackLanProof();
    expect(proof).toEqual({
      loopback: {
        authenticatedHealthRpc: true,
        healthStatus: 200,
        invalidTokenRejected: true,
        isolatedFromLanInterface: true,
      },
      lan: {
        authenticatedHealthRpc: true,
        healthStatus: 200,
        invalidTokenRejected: true,
        nonLoopbackInterface: true,
        reachableThroughInterface: true,
      },
    });
  }, 120_000);
});
