import { describe, expect, test } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("gateway trusted-proxy device auto-approval config", () => {
  test("accepts bounded non-admin scopes", () => {
    const result = OpenClawSchema.safeParse({
      gateway: {
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-forwarded-user",
            deviceAutoApprove: {
              enabled: true,
              scopes: ["operator.read", "operator.write", "operator.approvals"],
            },
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  test.each(["operator.admin", " operator.admin "])(
    "accepts %j as an explicit admin opt-in",
    (adminScope) => {
      const result = OpenClawSchema.safeParse({
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-forwarded-user",
              deviceAutoApprove: {
                enabled: true,
                scopes: ["operator.read", adminScope],
              },
            },
          },
        },
      });

      expect(result.success).toBe(true);
    },
  );
});

describe("gateway identity scope grants config", () => {
  test.each([
    { scope: "operator.admin", success: true },
    { scope: "operator.superuser", success: false },
  ])("validates configured scope $scope", ({ scope, success }) => {
    const result = OpenClawSchema.safeParse({
      gateway: {
        auth: {
          identityScopes: {
            "admin@example.com": [scope],
          },
        },
      },
    });

    expect(result.success).toBe(success);
  });
});
