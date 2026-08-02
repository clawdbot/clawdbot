import { describe, expect, it } from "vitest";
import {
  validatePluginApprovalCancelParams,
  validatePluginApprovalRequestParams,
} from "./index.js";
import { PluginApprovalCancelParamsSchema } from "./schema/plugin-approvals.js";
import { ProtocolSchemas } from "./schema/protocol-schemas.js";

describe("plugin approval protocol validators", () => {
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

  it("exports and validates exact cancellation params", () => {
    expect(ProtocolSchemas.PluginApprovalCancelParams).toBe(PluginApprovalCancelParamsSchema);
    expect(validatePluginApprovalCancelParams({})).toBe(false);
    expect(validatePluginApprovalCancelParams({ id: "plugin:approval-id" })).toBe(true);
    expect(validatePluginApprovalCancelParams({ runtimeRequestId: "runtime-request-id" })).toBe(
      true,
    );
    expect(validatePluginApprovalCancelParams({ id: "" })).toBe(false);
    expect(
      validatePluginApprovalCancelParams({
        id: "plugin:approval-id",
        runtimeRequestId: "runtime-request-id",
      }),
    ).toBe(false);
    expect(validatePluginApprovalCancelParams({ id: "plugin:approval-id", extra: true })).toBe(
      false,
    );
  });
});
