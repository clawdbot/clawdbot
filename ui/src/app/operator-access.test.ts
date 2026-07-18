// @vitest-environment node
import { describe, expect, it } from "vitest";
import { hasOperatorApprovalsAccess } from "./operator-access.ts";

describe("hasOperatorApprovalsAccess", () => {
  it("requires the approval scope when the gateway advertises scopes", () => {
    expect(hasOperatorApprovalsAccess({ role: "operator", scopes: ["operator.read"] })).toBe(false);
    expect(
      hasOperatorApprovalsAccess({
        role: "operator",
        scopes: ["operator.read", "operator.approvals"],
      }),
    ).toBe(true);
  });

  it("fails closed before auth but keeps established legacy auth compatible", () => {
    expect(hasOperatorApprovalsAccess(null)).toBe(false);
    expect(hasOperatorApprovalsAccess({ role: "operator" })).toBe(true);
  });
});
