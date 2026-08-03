import { describe, expect, it } from "vitest";
import {
  validateNodeInvokeProgressParams,
  validateNodePairingSnapshotParams,
  validateNodePairingSnapshotResult,
} from "../index.js";

describe("node protocol schemas", () => {
  const validSnapshotResult = {
    nodeId: "node-1",
    publicKeySha256: "a".repeat(64),
    pairingGenerationKey: "b".repeat(64),
    paired: true as const,
    nodeSurfaceApproved: true as const,
    observedAt: "2026-08-03T09:45:00.000Z",
    gatewayVersion: "2026.7.2",
    gatewayRuntimeStamp: "gateway-process-1",
  };

  it("accepts only the fixed snapshot request and non-secret result shape", () => {
    expect(validateNodePairingSnapshotParams({ nodeId: "node-1" })).toBe(true);
    expect(validateNodePairingSnapshotParams({ nodeId: "node-1", extra: true })).toBe(false);
    expect(validateNodePairingSnapshotParams({})).toBe(false);
    expect(validateNodePairingSnapshotParams({ nodeId: "" })).toBe(false);

    expect(validateNodePairingSnapshotResult(validSnapshotResult)).toBe(true);
    expect(
      validateNodePairingSnapshotResult({
        ...validSnapshotResult,
        publicKey: "must-not-leak",
      }),
    ).toBe(false);
    expect(validateNodePairingSnapshotResult({ ...validSnapshotResult, observedAt: 1 })).toBe(
      false,
    );

    for (const publicKeySha256 of ["a".repeat(63), "A".repeat(64), "z".repeat(64)]) {
      expect(validateNodePairingSnapshotResult({ ...validSnapshotResult, publicKeySha256 })).toBe(
        false,
      );
    }
    expect(
      validateNodePairingSnapshotResult({
        ...validSnapshotResult,
        pairingGenerationKey: "b".repeat(63),
      }),
    ).toBe(false);

    const { paired: _paired, ...withoutPaired } = validSnapshotResult;
    expect(validateNodePairingSnapshotResult(withoutPaired)).toBe(false);
    const { observedAt: _observedAt, ...withoutObservedAt } = validSnapshotResult;
    expect(validateNodePairingSnapshotResult(withoutObservedAt)).toBe(false);
  });

  it("accepts bounded progress chunks and rejects extra fields", () => {
    expect(
      validateNodeInvokeProgressParams({
        invokeId: "invoke-1",
        nodeId: "node-1",
        seq: 0,
        chunk: "stdout line",
      }),
    ).toBe(true);

    expect(
      validateNodeInvokeProgressParams({
        invokeId: "invoke-1",
        nodeId: "node-1",
        seq: 0,
        chunk: "x".repeat(16 * 1024 + 1),
      }),
    ).toBe(false);

    expect(
      validateNodeInvokeProgressParams({
        invokeId: "invoke-1",
        nodeId: "node-1",
        seq: 0,
        chunk: "stdout line",
        extra: "not allowed",
      }),
    ).toBe(false);
  });
});
