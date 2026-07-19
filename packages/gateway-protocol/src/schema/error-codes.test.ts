import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  GatewayErrorDetailsSchema,
  MissingScopeErrorDetailsSchema,
  missingScopeErrorShape,
  readMissingScopeError,
  readMissingScopeErrorDetails,
} from "./error-codes.js";

describe("gateway error details", () => {
  it("validates missing-scope details", () => {
    const details = {
      code: GatewayErrorDetailCodes.MISSING_SCOPE,
      missingScope: "operator.write",
      requiredScopes: ["operator.write"],
    };

    expect(Value.Check(MissingScopeErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(GatewayErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(MissingScopeErrorDetailsSchema, { ...details, requiredScopes: [] })).toBe(
      false,
    );
  });

  it("builds a distinct forbidden missing-scope response", () => {
    expect(
      missingScopeErrorShape({
        missingScope: "operator.approvals",
        requiredScopes: ["operator.read", "operator.approvals"],
      }),
    ).toEqual({
      code: ErrorCodes.FORBIDDEN,
      message: "missing scope: operator.approvals",
      details: {
        code: GatewayErrorDetailCodes.MISSING_SCOPE,
        missingScope: "operator.approvals",
        requiredScopes: ["operator.read", "operator.approvals"],
      },
    });
  });

  it("keeps requiredScopes non-empty when a caller has no method metadata", () => {
    expect(
      missingScopeErrorShape({ missingScope: "operator.admin", requiredScopes: [] }).details,
    ).toEqual({
      code: GatewayErrorDetailCodes.MISSING_SCOPE,
      missingScope: "operator.admin",
      requiredScopes: ["operator.admin"],
    });
  });

  it("reads structured missing-scope details without parsing the message", () => {
    expect(
      readMissingScopeError({
        code: ErrorCodes.FORBIDDEN,
        message: "permission denied",
        details: {
          code: GatewayErrorDetailCodes.MISSING_SCOPE,
          missingScope: "operator.questions",
          requiredScopes: ["operator.read", "operator.questions"],
        },
      }),
    ).toEqual({
      code: GatewayErrorDetailCodes.MISSING_SCOPE,
      missingScope: "operator.questions",
      requiredScopes: ["operator.read", "operator.questions"],
    });
  });

  it("falls back to the legacy message only for authorization error codes", () => {
    expect(
      readMissingScopeError({
        gatewayCode: ErrorCodes.INVALID_REQUEST,
        message: "missing scope: operator.read",
      }),
    ).toEqual({
      code: GatewayErrorDetailCodes.MISSING_SCOPE,
      missingScope: "operator.read",
      requiredScopes: ["operator.read"],
    });
    expect(
      readMissingScopeError({
        code: ErrorCodes.UNAVAILABLE,
        message: "missing scope: operator.read",
      }),
    ).toBeNull();
  });

  it("rejects malformed structured details", () => {
    expect(
      readMissingScopeErrorDetails({
        code: GatewayErrorDetailCodes.MISSING_SCOPE,
        missingScope: "operator.read",
        requiredScopes: [],
      }),
    ).toBeNull();
    expect(
      readMissingScopeErrorDetails({
        code: GatewayErrorDetailCodes.MISSING_SCOPE,
        missingScope: "operator.read",
        requiredScopes: ["operator.read", 42],
      }),
    ).toBeNull();
  });
});
