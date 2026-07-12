// Approval transport reference tests cover deterministic, kind-bound locators.
import { describe, expect, it } from "vitest";
import {
  APPROVAL_RESOLUTION_REF_LENGTH,
  buildApprovalResolutionRef,
  isApprovalResolutionRef,
} from "./approval-resolution-ref.js";

describe("approval resolution references", () => {
  it("builds a deterministic full-digest base64url transport locator", () => {
    const ref = buildApprovalResolutionRef({
      approvalId: "approval/with Unicode 😀",
      approvalKind: "exec",
    });

    expect(ref).toHaveLength(APPROVAL_RESOLUTION_REF_LENGTH);
    expect(isApprovalResolutionRef(ref)).toBe(true);
    expect(
      buildApprovalResolutionRef({
        approvalId: "approval/with Unicode 😀",
        approvalKind: "exec",
      }),
    ).toBe(ref);
  });

  it("binds the locator to the exact id and owner kind", () => {
    const execRef = buildApprovalResolutionRef({ approvalId: "same-id", approvalKind: "exec" });
    expect(buildApprovalResolutionRef({ approvalId: "same-id", approvalKind: "plugin" })).not.toBe(
      execRef,
    );
    expect(buildApprovalResolutionRef({ approvalId: "same-id ", approvalKind: "exec" })).not.toBe(
      execRef,
    );
  });

  it.each(["", "a".repeat(42), "a".repeat(44), "!".repeat(43)])(
    "rejects malformed transport references %#",
    (value) => {
      expect(isApprovalResolutionRef(value)).toBe(false);
    },
  );
});
