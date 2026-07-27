import { describe, expect, it } from "vitest";
import { validateGatewayRestoreStatusParams } from "./index.js";

describe("gateway restore protocol", () => {
  it("accepts the bounded restore operation token", () => {
    expect(validateGatewayRestoreStatusParams({ restoreOperationId: "restore/tenant-7:8" })).toBe(
      true,
    );
  });

  it.each([
    {},
    { restoreOperationId: "" },
    { restoreOperationId: " restore-8" },
    { restoreOperationId: "restore 8" },
    { restoreOperationId: "restore-8", extra: true },
    { restoreOperationId: "r".repeat(256) },
  ])("rejects invalid or open request shapes: %j", (params) => {
    expect(validateGatewayRestoreStatusParams(params)).toBe(false);
  });
});
