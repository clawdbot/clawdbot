import { describe, expect, it } from "vitest";
import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { verifyWorkerAdmissionHandshake } from "./admission.js";

const expectedBundleHash = "a".repeat(64);
const handshake: WorkerAdmissionHandshake = {
  bundleHash: expectedBundleHash,
  openclawVersion: "2026.7.11",
  protocolFeatures: [],
};

describe("worker admission", () => {
  it("accepts the expected bundle build", () => {
    expect(verifyWorkerAdmissionHandshake(handshake, expectedBundleHash)).toBe(true);
  });

  it("rejects a different bundle build", () => {
    const differentBundleHash = `${expectedBundleHash.slice(0, -1)}b`;
    expect(verifyWorkerAdmissionHandshake(handshake, differentBundleHash)).toBe(false);
  });
});
