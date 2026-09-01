import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  ErrorCodes,
  CronJobNotFoundErrorDetailsSchema,
  GatewayErrorDetailCodes,
  GatewayErrorDetailsSchema,
  isMcpAppViewExpiredError,
  McpAppViewExpiredErrorDetailsSchema,
  MissingScopeErrorDetailsSchema,
  OutboundDeliveryQueuedErrorDetailsSchema,
  ProjectCloneErrorDetailsSchema,
  SkillProposalRevisionChangedErrorDetailsSchema,
  missingScopeErrorShape,
  readSkillProposalRevisionChangedError,
  readMissingScopeError,
  readMissingScopeErrorDetails,
  readCronJobNotFoundError,
  UnknownAgentIdErrorDetailsSchema,
} from "./error-codes.js";
import { ErrorShapeSchema } from "./frames.js";

describe("gateway error details", () => {
  it("validates and reads cron job lookup misses", () => {
    const details = {
      code: GatewayErrorDetailCodes.CRON_JOB_NOT_FOUND,
      jobId: "job-123",
    };

    expect(Value.Check(CronJobNotFoundErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(GatewayErrorDetailsSchema, details)).toBe(true);
    expect(readCronJobNotFoundError({ details })).toEqual(details);
    expect(readCronJobNotFoundError({ details: { ...details, jobId: "" } })).toBeNull();
  });

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

  it("identifies MCP App lease expiry without message parsing", () => {
    const details = { code: GatewayErrorDetailCodes.MCP_APP_VIEW_EXPIRED };
    expect(Value.Check(McpAppViewExpiredErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(GatewayErrorDetailsSchema, details)).toBe(true);
    expect(isMcpAppViewExpiredError({ details })).toBe(true);
    expect(isMcpAppViewExpiredError(new Error("upstream token expired"))).toBe(false);
  });

  it("validates queued outbound delivery details", () => {
    const details = { code: GatewayErrorDetailCodes.OUTBOUND_DELIVERY_QUEUED };
    expect(Value.Check(OutboundDeliveryQueuedErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(GatewayErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(OutboundDeliveryQueuedErrorDetailsSchema, { ...details, retry: true })).toBe(
      false,
    );
  });

  it("validates unknown-agent details", () => {
    const details = { code: GatewayErrorDetailCodes.UNKNOWN_AGENT_ID, agentId: "retired" };
    expect(Value.Check(UnknownAgentIdErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(GatewayErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(UnknownAgentIdErrorDetailsSchema, { ...details, agentId: "" })).toBe(false);
  });

  it.each(["WIZARD_NOT_FOUND", "SETUP_ADMISSION_BUSY"])("validates closed %s details", (code) => {
    const details = { code };
    expect(Value.Check(ErrorShapeSchema, { code: "UNAVAILABLE", message: "busy", details })).toBe(
      true,
    );
    expect(Value.Check(GatewayErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(GatewayErrorDetailsSchema, { ...details, sessionId: "stale" })).toBe(false);
    expect(
      Value.Check(ErrorShapeSchema, {
        code: "UNAVAILABLE",
        message: "other failure",
        details: { code: "future_detail", context: 1 },
      }),
    ).toBe(true);
  });

  it("validates typed project clone failures", () => {
    const details = {
      code: GatewayErrorDetailCodes.PROJECT_CLONE_FAILED,
      cause: "auth_required",
    };
    expect(Value.Check(ProjectCloneErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(GatewayErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(ProjectCloneErrorDetailsSchema, { ...details, cause: "unknown" })).toBe(
      false,
    );
  });

  it("validates and reads changed skill proposal revisions", () => {
    const details = {
      code: GatewayErrorDetailCodes.SKILL_PROPOSAL_REVISION_CHANGED,
      expectedRevisionHash: "A".repeat(64),
      currentRevisionHash: "b".repeat(64),
    };

    expect(Value.Check(SkillProposalRevisionChangedErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(GatewayErrorDetailsSchema, details)).toBe(true);
    expect(readSkillProposalRevisionChangedError({ details })).toEqual(details);
    expect(
      readSkillProposalRevisionChangedError({
        details: { ...details, currentRevisionHash: "not-a-sha256" },
      }),
    ).toBeNull();
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
