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

  test.each(["operator.admin", " operator.admin "])("rejects %j", (adminScope) => {
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

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["gateway", "auth", "trustedProxy", "deviceAutoApprove", "scopes"],
            message: expect.stringContaining("operator.admin is not allowed"),
          }),
        ]),
      );
    }
  });
});
