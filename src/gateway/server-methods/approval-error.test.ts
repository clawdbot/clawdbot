import { describe, expect, it } from "vitest";
import { approvalNotFoundErrorShape } from "./approval-error.js";

describe("approvalNotFoundErrorShape", () => {
  it.each(["approval not found", "unknown or expired approval id"] as const)(
    "preserves canonical English and adds the reviewed descriptor: %s",
    (message) => {
      expect(approvalNotFoundErrorShape({ message })).toEqual({
        code: "INVALID_REQUEST",
        message,
        details: {
          reason: "APPROVAL_NOT_FOUND",
          localization: { messageKey: "gateway.approval.notFound" },
        },
      });
    },
  );

  it("preserves remediation as literal protocol data", () => {
    expect(
      approvalNotFoundErrorShape({
        message: "unknown or expired approval id",
        remediation: "Re-request the action.",
      }).details,
    ).toMatchObject({
      remediation: "Re-request the action.",
      localization: { messageKey: "gateway.approval.notFound" },
    });
  });
});
