import { describe, expect, test } from "vitest";
import {
  approveDevicePairing,
  getPairedDevice,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import { installGatewayTestHooks } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway device.pair.approve superseded request ids", () => {
  test("rejects approving a superseded request id", async () => {
    const first = await requestDevicePairing({
      deviceId: "supersede-device-1",
      publicKey: "supersede-public-key",
      role: "node",
      scopes: ["node.exec"],
    });
    const second = await requestDevicePairing({
      deviceId: "supersede-device-1",
      publicKey: "supersede-public-key",
      role: "operator",
      scopes: ["operator.admin"],
    });

    expect(second.request.requestId).not.toBe(first.request.requestId);

    const staleApprove = await approveDevicePairing(first.request.requestId, {
      callerScopes: ["operator.admin"],
    });
    expect(staleApprove).toBeNull();

    const latestApprove = await approveDevicePairing(second.request.requestId, {
      callerScopes: ["operator.admin"],
    });
    expect(latestApprove?.status).toBe("approved");

    const paired = await getPairedDevice("supersede-device-1");
    expect(paired?.roles).toContain("node");
    expect(paired?.roles).toContain("operator");
    expect(paired?.scopes).toContain("operator.admin");
  });
});
