// @vitest-environment node
import { describe, expect, it } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
import {
  isMissingOperatorReadScopeError,
  isWizardNotFoundError,
  isSetupAdmissionBusyError,
} from "./gateway-errors.ts";

function gatewayRequestError(params: { code: string; message: string; details?: unknown }): Error {
  return Object.assign(new Error(params.message), {
    name: "GatewayRequestError",
    code: params.code,
    gatewayCode: params.code,
    details: params.details,
  });
}

describe("gateway error helpers", () => {
  it.each([
    [isWizardNotFoundError, "INVALID_REQUEST", "WIZARD_NOT_FOUND"],
    [isSetupAdmissionBusyError, "UNAVAILABLE", "SETUP_ADMISSION_BUSY"],
  ] as const)(
    "classifies structured %s %s %s without parsing copy",
    (classify, code, detailCode) => {
      expect(
        classify(
          new GatewayRequestError({
            code,
            message: "localized or changed public copy",
            details: { code: detailCode },
          }),
        ),
      ).toBe(true);
      expect(
        classify({
          gatewayCode: code,
          details: { code: detailCode },
        }),
      ).toBe(true);
    },
  );

  it.each([
    [isWizardNotFoundError, "INVALID_REQUEST", "WIZARD_NOT_FOUND", "UNAVAILABLE"],
    [isSetupAdmissionBusyError, "UNAVAILABLE", "SETUP_ADMISSION_BUSY", "INVALID_REQUEST"],
  ] as const)("rejects unrelated %s %s %s %s errors", (classify, code, detailCode, wrongCode) => {
    expect(
      classify({
        gatewayCode: wrongCode,
        details: { code: detailCode },
      }),
    ).toBe(false);
    expect(
      classify({
        gatewayCode: code,
        details: { code: "UNKNOWN_AGENT_ID" },
      }),
    ).toBe(false);
    expect(classify({ gatewayCode: code, message: "wizard not found" })).toBe(false);
    for (const details of [null, detailCode, [], { code: 42 }]) {
      expect(classify({ gatewayCode: code, details })).toBe(false);
    }
  });

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
