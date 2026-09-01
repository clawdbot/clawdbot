import { describe, expect, expectTypeOf, it } from "vitest";
import { validatePluginApprovalRequestParams } from "./index.js";
import type {
  PluginApprovalExternalPrepareParams,
  PluginApprovalExternalPrepareResult,
  PluginApprovalExternalStartResult,
} from "./schema/plugin-approvals.js";

const nullableMetadataFields = [
  "pluginId",
  "detail",
  "severity",
  "scope",
  "toolName",
  "toolCallId",
  "allowedDecisions",
  "agentId",
  "sessionKey",
  "approvalReviewerDeviceIds",
  "turnSourceChannel",
  "turnSourceTo",
  "turnSourceAccountId",
  "turnSourceThreadId",
] as const;

describe("plugin approval protocol validators", () => {
  it("keeps external action wire enums closed in the public types", () => {
    expectTypeOf<PluginApprovalExternalPrepareParams["decision"]>().toEqualTypeOf<
      "allow-once" | "allow-always"
    >();
    expectTypeOf<PluginApprovalExternalPrepareResult["intent"]>().toEqualTypeOf<
      "start" | "retry"
    >();
    expectTypeOf<PluginApprovalExternalStartResult["outcome"]>().toEqualTypeOf<
      "started" | "replay" | "stale-action"
    >();
  });

  it("validates bounded reviewer-only detail independently from the description", () => {
    const request = {
      title: "Apply workspace skill proposal",
      description: "d".repeat(512),
    };

    expect(validatePluginApprovalRequestParams(request)).toBe(true);
    expect(validatePluginApprovalRequestParams({ ...request, detail: "full tool input" })).toBe(
      true,
    );
    expect(validatePluginApprovalRequestParams({ ...request, detail: "" })).toBe(false);
    expect(validatePluginApprovalRequestParams({ ...request, detail: "x".repeat(16_385) })).toBe(
      false,
    );
    expect(validatePluginApprovalRequestParams({ ...request, description: "d".repeat(513) })).toBe(
      false,
    );
  });

  it.each(nullableMetadataFields)("accepts explicit null for optional %s metadata", (field) => {
    expect(
      validatePluginApprovalRequestParams({
        title: "Apply workspace skill proposal",
        description: "Apply the pending proposal",
        [field]: null,
      }),
    ).toBe(true);
  });
});
