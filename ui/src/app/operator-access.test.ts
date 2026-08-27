// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import {
  hasOperatorApprovalsAccess,
  hasOperatorPairingAccess,
  hasOperatorReadAccess,
  readGatewayOperatorAccess,
} from "./operator-access.ts";

describe("readGatewayOperatorAccess", () => {
  it.each([
    {
      name: "an absent snapshot",
      snapshot: null,
      expected: [true, true, false, true, false],
    },
    {
      name: "an absent hello",
      snapshot: { hello: null },
      expected: [true, true, false, true, false],
    },
    {
      name: "legacy operator authentication",
      snapshot: { hello: { auth: { role: "operator" } } },
      expected: [true, true, true, true, true],
    },
    {
      name: "explicitly empty scopes",
      snapshot: { hello: { auth: { role: "operator", scopes: [] } } },
      expected: [false, false, false, false, false],
    },
    {
      name: "read-only access",
      snapshot: { hello: { auth: { role: "operator", scopes: ["operator.read"] } } },
      expected: [false, false, false, false, false],
    },
    {
      name: "write access",
      snapshot: { hello: { auth: { role: "operator", scopes: ["operator.write"] } } },
      expected: [true, false, false, false, false],
    },
    {
      name: "approval access",
      snapshot: { hello: { auth: { role: "operator", scopes: ["operator.approvals"] } } },
      expected: [false, false, false, true, true],
    },
    {
      name: "pairing access",
      snapshot: { hello: { auth: { role: "operator", scopes: ["operator.pairing"] } } },
      expected: [false, false, true, false, false],
    },
    {
      name: "administrator access",
      snapshot: { hello: { auth: { role: "operator", scopes: ["operator.admin"] } } },
      expected: [true, true, true, true, true],
    },
    {
      name: "a foreign role with an operator scope",
      snapshot: { hello: { auth: { role: "node", scopes: ["node.read", "operator.admin"] } } },
      expected: [false, false, false, false, false],
    },
  ])("projects $name from the current Gateway snapshot", ({ snapshot, expected }) => {
    expect(
      readGatewayOperatorAccess(snapshot as Pick<ApplicationGatewaySnapshot, "hello"> | null),
    ).toEqual({
      canWrite: expected[0],
      canAdmin: expected[1],
      canPair: expected[2],
      canReviewApprovals: expected[3],
      canGrantApprovals: expected[4],
    });
  });
});

describe("hasOperatorReadAccess", () => {
  it("accepts read, implied write/admin, and legacy access but rejects unrelated scopes", () => {
    expect(hasOperatorReadAccess(null)).toBe(true);
    expect(hasOperatorReadAccess({ role: "operator", scopes: ["operator.read"] })).toBe(true);
    expect(hasOperatorReadAccess({ role: "operator", scopes: ["operator.write"] })).toBe(true);
    expect(hasOperatorReadAccess({ role: "operator", scopes: ["operator.admin"] })).toBe(true);
    expect(hasOperatorReadAccess({ role: "operator" })).toBe(true);
    expect(hasOperatorReadAccess({ role: "operator", scopes: ["operator.pairing"] })).toBe(false);
  });
});

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
