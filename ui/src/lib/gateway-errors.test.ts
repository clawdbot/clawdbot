import { describe, expect, it } from "vitest";
import { isMissingOperatorReadScopeError } from "./gateway-errors.ts";

function gatewayRequestError(params: { code: string; message: string; details?: unknown }): Error {
  return Object.assign(new Error(params.message), {
    name: "GatewayRequestError",
    code: params.code,
    gatewayCode: params.code,
    details: params.details,
  });
}

describe("gateway error helpers", () => {
  it("classifies structured read-scope failures without message parsing", () => {
    expect(
      isMissingOperatorReadScopeError(
        gatewayRequestError({
          code: "FORBIDDEN",
          message: "permission denied",
          details: {
            code: "MISSING_SCOPE",
            missingScope: "operator.read",
            requiredScopes: ["operator.read"],
          },
        }),
      ),
    ).toBe(true);
  });

  it("keeps compatibility with legacy scope messages and detail codes", () => {
    expect(
      isMissingOperatorReadScopeError(
        gatewayRequestError({
          code: "INVALID_REQUEST",
          message: "missing scope: operator.read",
        }),
      ),
    ).toBe(true);
    expect(
      isMissingOperatorReadScopeError(
        gatewayRequestError({
          code: "INVALID_REQUEST",
          message: "unauthorized",
          details: { code: "AUTH_UNAUTHORIZED" },
        }),
      ),
    ).toBe(true);
  });

  it("does not confuse another missing scope with operator.read", () => {
    expect(
      isMissingOperatorReadScopeError(
        gatewayRequestError({
          code: "FORBIDDEN",
          message: "missing scope: operator.questions",
          details: {
            code: "MISSING_SCOPE",
            missingScope: "operator.questions",
            requiredScopes: ["operator.questions"],
          },
        }),
      ),
    ).toBe(false);
  });
});
