import { describe, expect, it } from "vitest";
import {
  attachGatewayErrorLocalization,
  attachKnownGatewayErrorLocalization,
  readGatewayErrorLocalization,
} from "./error-localization.js";
import { ErrorCodes } from "./gateway-error-details.js";
import { errorShape } from "./schema/error-codes.js";

describe("Gateway error localization metadata", () => {
  it("attaches the reviewed approval descriptor without inspecting English copy", () => {
    for (const message of ["unknown or expired approval id", "approval not found"]) {
      const localized = attachKnownGatewayErrorLocalization(
        errorShape(ErrorCodes.INVALID_REQUEST, message, {
          details: { reason: ErrorCodes.APPROVAL_NOT_FOUND },
          retryable: true,
          retryAfterMs: 250,
        }),
      );
      expect(localized).toMatchObject({
        code: ErrorCodes.INVALID_REQUEST,
        message,
        retryable: true,
        retryAfterMs: 250,
        details: {
          reason: ErrorCodes.APPROVAL_NOT_FOUND,
          localization: { messageKey: "gateway.approval.notFound" },
        },
      });
    }
  });

  it("leaves unknown and already-described errors unchanged", () => {
    const messageOnly = errorShape(ErrorCodes.INVALID_REQUEST, "approval not found");
    const wrongReason = errorShape(ErrorCodes.INVALID_REQUEST, "approval not found", {
      details: { reason: "SOME_OTHER_REASON" },
    });
    expect(attachKnownGatewayErrorLocalization(messageOnly)).toBe(messageOnly);
    expect(attachKnownGatewayErrorLocalization(wrongReason)).toBe(wrongReason);

    const described = attachGatewayErrorLocalization(
      errorShape(ErrorCodes.INVALID_REQUEST, "approval not found", {
        details: { reason: ErrorCodes.APPROVAL_NOT_FOUND },
      }),
      { messageKey: "gateway.approval.notFound" },
    );
    expect(attachKnownGatewayErrorLocalization(described)).toBe(described);
  });

  it("rejects malformed and unbounded metadata from untrusted payloads", () => {
    expect(
      readGatewayErrorLocalization({ details: { localization: { messageKey: "bad" } } }),
    ).toBeNull();
    expect(
      readGatewayErrorLocalization({
        details: {
          localization: {
            messageKey: "gateway.approval.notFound",
            messageParams: { nested: { unsafe: true } },
          },
        },
      }),
    ).toBeNull();
    expect(() =>
      attachGatewayErrorLocalization(
        errorShape(ErrorCodes.INVALID_REQUEST, "approval not found", { details: "opaque" }),
        { messageKey: "gateway.approval.notFound" },
      ),
    ).toThrow("object-shaped details");
  });
});
