import { describe, expect, it, vi } from "vitest";
import type { GatewayRestoreStatusResult } from "../../../packages/gateway-protocol/src/index.js";
import { restoreHandlers } from "./restore.js";
import type { GatewayRequestHandler } from "./types.js";

const restoreStatus = restoreHandlers["gateway.restore.status"] as GatewayRequestHandler;

function invoke(params: Record<string, unknown>, result: GatewayRestoreStatusResult) {
  const respond = vi.fn();
  void restoreStatus({
    req: { type: "req", id: "request-1", method: "gateway.restore.status" },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {
      getRestoredAdmissionStatus: () => result,
    } as Parameters<GatewayRequestHandler>[0]["context"],
  });
  return respond;
}

const held = {
  status: "held",
  reason: "owner-readiness",
  retryAfterMs: 1_000,
  runtimeLineage: "runtime/tenant-7",
  lifecycleOwnerGeneration: "owner-8",
  destinationRuntimeGeneration: "runtime-8",
  restoreOperationId: "restore-8",
  destinationOwner: "lobster/tenant-7",
  admissionIdentity: "admission-8",
  recoveryPointId: "a".repeat(64),
  acceptanceSetId: "b".repeat(64),
  restoreReceiptIdentity: "c".repeat(64),
} as const satisfies GatewayRestoreStatusResult;

describe("gateway.restore.status", () => {
  it("returns not-restored for an ordinary Gateway", () => {
    const respond = invoke({ restoreOperationId: "restore-8" }, { status: "not-restored" });
    expect(respond).toHaveBeenCalledWith(true, { status: "not-restored" });
  });

  it("returns the matching held projection", () => {
    const respond = invoke({ restoreOperationId: "restore-8" }, held);
    expect(respond).toHaveBeenCalledWith(true, held);
  });

  it("rejects a mismatched operation without disclosing the active identity", () => {
    const respond = invoke({ restoreOperationId: "restore-9" }, held);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        retryable: false,
        details: { reason: "restored-admission-conflict" },
      }),
    );
    expect(JSON.stringify(respond.mock.calls)).not.toContain("restore-8");
  });

  it("rejects an invalid token", () => {
    const respond = invoke({ restoreOperationId: " restore-8" }, held);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
