// Device pairing access tests cover role and scope checks for pairing requests.
import { describe, expect, it } from "vitest";
import { resolvePendingDeviceApprovalState } from "./device-pairing-access.js";

describe("resolvePendingDeviceApprovalState", () => {
  it("treats legacy singular approved role fields as approved access", () => {
    expect(
      resolvePendingDeviceApprovalState(
        {
          role: "operator",
          scopes: ["operator.read"],
        },
        {
          role: "operator",
          scopes: ["operator.read"],
        },
      ),
    ).toEqual({
      kind: "re-approval",
      requested: {
        roles: ["operator"],
        scopes: ["operator.read"],
      },
      approved: {
        roles: ["operator"],
        scopes: ["operator.read"],
      },
    });
  });

  it("treats revoked approved-role tokens as a role upgrade", () => {
    expect(
      resolvePendingDeviceApprovalState(
        {
          role: "operator",
          scopes: ["operator.read"],
        },
        {
          role: "operator",
          scopes: ["operator.read"],
          tokens: {
            operator: {
              role: "operator",
              revokedAtMs: Date.now(),
            },
          },
        },
      ),
    ).toEqual({
      kind: "role-upgrade",
      requested: {
        roles: ["operator"],
        scopes: ["operator.read"],
      },
      approved: {
        roles: [],
        scopes: ["operator.read"],
      },
    });
  });

  it("drops non-string role entries from malformed pairing records instead of crashing", () => {
    // Legacy/malformed on-disk pairing records can carry non-string roles/role (blind-cast JSON);
    // before the shared-normalizer guard these crashed normalizeRoleList on .trim().
    type PendingArg = Parameters<typeof resolvePendingDeviceApprovalState>[0];
    type PairedArg = NonNullable<Parameters<typeof resolvePendingDeviceApprovalState>[1]>;
    expect(
      resolvePendingDeviceApprovalState(
        {
          roles: [123, "operator", null, "  admin  "],
          role: 5,
          scopes: ["operator.read"],
        } as unknown as PendingArg,
        {
          roles: [null, "operator"],
          role: 9,
          scopes: ["operator.read"],
        } as unknown as PairedArg,
      ),
    ).toEqual({
      kind: "role-upgrade",
      requested: {
        roles: ["admin", "operator"],
        scopes: ["operator.read"],
      },
      approved: {
        roles: ["operator"],
        scopes: ["operator.read"],
      },
    });
  });

  it("drops a non-string token role without crashing", () => {
    type PairedArg = NonNullable<Parameters<typeof resolvePendingDeviceApprovalState>[1]>;
    expect(
      resolvePendingDeviceApprovalState({ role: "operator", scopes: ["operator.read"] }, {
        roles: ["operator"],
        scopes: ["operator.read"],
        tokens: { t1: { role: 7, revokedAtMs: null } },
      } as unknown as PairedArg),
    ).toEqual({
      kind: "role-upgrade",
      requested: {
        roles: ["operator"],
        scopes: ["operator.read"],
      },
      approved: {
        roles: [],
        scopes: ["operator.read"],
      },
    });
  });
});
