// Control UI tests cover connect error behavior.
import { describe, expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import { formatConnectError } from "./connect-error.ts";

describe("formatConnectError", () => {
  it("explains scope upgrades that require approval", () => {
    expect(
      formatConnectError({
        message: "pairing required",
        details: {
          code: ConnectErrorDetailCodes.PAIRING_REQUIRED,
          reason: "scope-upgrade",
          approvedScopes: ["operator.read"],
          requestedScopes: ["operator.admin", "operator.read"],
        },
      }),
    ).toBe(
      "device scope upgrade requires approval (approved: operator.read; requested: operator.admin, operator.read)",
    );
  });

  it("explains role upgrades that require approval", () => {
    expect(
      formatConnectError({
        message: "pairing required",
        details: {
          code: ConnectErrorDetailCodes.PAIRING_REQUIRED,
          reason: "role-upgrade",
          approvedRoles: ["operator"],
          requestedRole: "node",
        },
      }),
    ).toBe("device role upgrade requires approval (approved: operator; requested: node)");
  });

  it("routes missing browser identity to a supported secure context", () => {
    expect(
      formatConnectError({
        message: "device identity required",
        details: { code: ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED },
      }),
    ).toBe("device identity required (use HTTPS or localhost)");
  });
});
