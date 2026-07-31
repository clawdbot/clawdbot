import { describe, expect, it } from "vitest";
import type { ClawLifecyclePlanResult } from "../../../../packages/gateway-protocol/src/index.js";
import { buildClawApplyRequest, catalogUpdateTargets } from "./lifecycle-request.ts";

const plan: ClawLifecyclePlanResult = {
  schemaVersion: "openclaw.clawsGatewayPlan.v1",
  operation: "update",
  planIntegrity: "sha256:exact-preview-token",
  target: { agentId: "analyst" },
  actions: [],
  capabilities: [],
  blockers: [],
  riskAcknowledgementRequired: true,
};

describe("Claw lifecycle requests", () => {
  it("requires an explicitly selected agent when a package has multiple installs", () => {
    const records = [
      { name: "analyst", agentId: "analyst-one" },
      { name: "analyst", agentId: "analyst-two" },
      { name: "support", agentId: "support" },
    ];
    expect(catalogUpdateTargets(records, "analyst", null, false)).toHaveLength(2);
    expect(catalogUpdateTargets(records, "analyst", "analyst-two", true)).toEqual([records[1]]);
  });

  it("binds the selected immutable release and consent to its preview token", () => {
    expect(
      buildClawApplyRequest({
        pending: {
          operation: "update",
          target: "analyst",
          source: { packageName: "financial-analyst", version: "1.2.0" },
        },
        plan,
        removeUnused: false,
        riskAcknowledged: true,
      }),
    ).toEqual({
      method: "claws.update.apply",
      request: {
        target: "analyst",
        source: { packageName: "financial-analyst", version: "1.2.0" },
        planIntegrity: "sha256:exact-preview-token",
        acknowledgeClawHubRisk: true,
      },
    });
  });

  it("refuses blocked, mismatched, or unacknowledged mutations", () => {
    expect(
      buildClawApplyRequest({
        pending: { operation: "update", target: "analyst" },
        plan,
        removeUnused: false,
        riskAcknowledged: false,
      }),
    ).toBeNull();
    expect(
      buildClawApplyRequest({
        pending: { operation: "remove", target: "analyst" },
        plan,
        removeUnused: true,
        riskAcknowledged: true,
      }),
    ).toBeNull();
    expect(
      buildClawApplyRequest({
        pending: { operation: "update", target: "analyst" },
        plan: { ...plan, blockers: [{ code: "changed", path: "$", message: "Preview again." }] },
        removeUnused: false,
        riskAcknowledged: true,
      }),
    ).toBeNull();
  });

  it("binds explicit cleanup choice to removal", () => {
    expect(
      buildClawApplyRequest({
        pending: { operation: "remove", target: "analyst" },
        plan: { ...plan, operation: "remove", riskAcknowledgementRequired: false },
        removeUnused: true,
        riskAcknowledged: false,
      }),
    ).toEqual({
      method: "claws.remove.apply",
      request: {
        target: "analyst",
        removeUnused: true,
        planIntegrity: "sha256:exact-preview-token",
      },
    });
  });
});
