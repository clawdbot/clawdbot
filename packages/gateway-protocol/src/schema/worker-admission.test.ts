import { describe, expect, it } from "vitest";
import { type WorkerAdmissionHandshake, validateWorkerAdmissionHandshake } from "../index.js";

const bundleHash = "a".repeat(64);
const handshake: WorkerAdmissionHandshake = {
  bundleHash,
  openclawVersion: "2026.7.11",
  protocolFeatures: [],
};

describe("worker admission handshake schema", () => {
  it("accepts the bootstrap receipt and future unique feature names", () => {
    expect(validateWorkerAdmissionHandshake(handshake)).toBe(true);
    expect(
      validateWorkerAdmissionHandshake({
        ...handshake,
        protocolFeatures: ["run-v1", "resume-v1"],
      }),
    ).toBe(true);
  });

  it.each([
    { ...handshake, bundleHash: "short" },
    { ...handshake, bundleHash: "A".repeat(64) },
    { ...handshake, openclawVersion: "" },
    { ...handshake, protocolFeatures: [""] },
    { ...handshake, protocolFeatures: ["run-v1", "run-v1"] },
    { ...handshake, unexpected: true },
  ])("rejects malformed admission identity %#", (candidate) => {
    expect(validateWorkerAdmissionHandshake(candidate)).toBe(false);
  });
});
