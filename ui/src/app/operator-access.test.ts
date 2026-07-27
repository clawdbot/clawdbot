// @vitest-environment node
import { describe, expect, it } from "vitest";
import { hasOperatorApprovalsAccess, hasOperatorPairingAccess } from "./operator-access.ts";

describe("hasOperatorPairingAccess", () => {
  it("requires pairing scope while keeping admin and legacy auth compatible", () => {
    expect(hasOperatorPairingAccess(null)).toBe(false);
    expect(hasOperatorPairingAccess({ role: "operator" })).toBe(true);
    expect(hasOperatorPairingAccess({ role: "operator", scopes: ["operator.read"] })).toBe(false);
    expect(hasOperatorPairingAccess({ role: "operator", scopes: ["operator.pairing"] })).toBe(true);
    expect(hasOperatorPairingAccess({ role: "operator", scopes: ["operator.admin"] })).toBe(true);
  });
});

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
