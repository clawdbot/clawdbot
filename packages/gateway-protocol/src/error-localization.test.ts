import { describe, expect, it } from "vitest";
import {
  attachGatewayErrorLocalization,
  attachKnownGatewayErrorLocalization,
  readGatewayErrorLocalization,
} from "./error-localization.js";
import { ErrorCodes } from "./gateway-error-details.js";
import { errorShape } from "./schema/error-codes.js";

function untrustedDescriptor(
  overrides: {
    code?: string;
    reason?: unknown;
    localization?: unknown;
  } = {},
) {
  return {
    code: overrides.code ?? ErrorCodes.INVALID_REQUEST,
    details: {
      reason: overrides.reason ?? ErrorCodes.APPROVAL_NOT_FOUND,
      localization: overrides.localization ?? { messageKey: "gateway.approval.notFound" },
    },
  };
}

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

  it("accepts only the descriptor's complete discriminator tuple and exact shape", () => {
    expect(readGatewayErrorLocalization(untrustedDescriptor())).toEqual({
      messageKey: "gateway.approval.notFound",
    });
    for (const candidate of [
      untrustedDescriptor({ code: ErrorCodes.UNAVAILABLE }),
      untrustedDescriptor({ reason: "OTHER" }),
      untrustedDescriptor({ localization: { messageKey: "gateway.unreviewed" } }),
      untrustedDescriptor({
        localization: { messageKey: "gateway.approval.notFound", extra: true },
      }),
      untrustedDescriptor({
        localization: { messageKey: "gateway.approval.notFound", messageParams: {} },
      }),
      untrustedDescriptor({ localization: { messageKey: "gateway." + "x".repeat(10_000) } }),
      untrustedDescriptor({ localization: "malformed" }),
      { code: ErrorCodes.INVALID_REQUEST, details: "malformed" },
    ]) {
      expect(readGatewayErrorLocalization(candidate)).toBeNull();
    }
  });

  it("rejects invalid attachment boundaries", () => {
    expect(() =>
      attachGatewayErrorLocalization(
        errorShape(ErrorCodes.INVALID_REQUEST, "approval not found", { details: "opaque" }),
        { messageKey: "gateway.approval.notFound" },
      ),
    ).toThrow("object-shaped details");
    expect(() =>
      attachGatewayErrorLocalization(
        errorShape(ErrorCodes.UNAVAILABLE, "approval not found", {
          details: { reason: ErrorCodes.APPROVAL_NOT_FOUND },
        }),
        { messageKey: "gateway.approval.notFound" },
      ),
    ).toThrow("Invalid Gateway error localization metadata");
  });
});
