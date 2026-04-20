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
});
