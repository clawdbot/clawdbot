import { describe, expect, it } from "vitest";
import type { ClawLifecyclePlanResult } from "../../../../packages/gateway-protocol/src/index.js";
import {
  buildClawApplyRequest,
  catalogUpdateTargets,
  seedDestinationsForAnswer,
  setupAnswerEditable,
} from "./lifecycle-request.ts";

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

describe("buildClawApplyRequest", () => {
  it("requires an exact selected agent when a catalog package has multiple installs", () => {
    const records = [
      { name: "analyst", agentId: "analyst-one" },
      { name: "analyst", agentId: "analyst-two" },
      { name: "support", agentId: "support" },
    ];

    expect(catalogUpdateTargets(records, "analyst", null, false)).toHaveLength(2);
    expect(catalogUpdateTargets(records, "analyst", "analyst-one", false)).toHaveLength(2);
    expect(catalogUpdateTargets(records, "analyst", "analyst-two", true)).toEqual([records[1]]);
    expect(catalogUpdateTargets(records, "analyst", "support", true)).toHaveLength(2);
  });

  it("selects only personalization seeds affected by a changed answer", () => {
    expect(
      seedDestinationsForAnswer(
        {
          valid: true,
          inputs: [],
          providedInputIds: [],
          defaultedInputIds: [],
          missingOptionalInputIds: [],
          diagnostics: [],
          seeds: [
            { destination: "USER.md", inputIds: ["name"], blocked: false },
            { destination: "PREFERENCES.md", inputIds: ["timezone", "tone"], blocked: false },
          ],
        },
        "timezone",
      ),
    ).toEqual(["PREFERENCES.md"]);
  });

  it("edits update answers only when the update creates their seed", () => {
    const setup = {
      valid: true,
      inputs: [],
      providedInputIds: [],
      defaultedInputIds: [],
      missingOptionalInputIds: [],
      diagnostics: [],
      seeds: [
        { destination: "USER.md", inputIds: ["name"], blocked: false },
        { destination: "NEW.md", inputIds: ["timezone"], blocked: true },
      ],
    };
    const update = {
      ...plan,
      setup,
      actions: [
        { kind: "personalizationSeed", id: "USER.md", action: "unchanged", blocked: false },
        { kind: "personalizationSeed", id: "NEW.md", action: "manual", blocked: true },
      ],
    };

    expect(setupAnswerEditable(update, "name")).toBe(false);
    expect(setupAnswerEditable(update, "timezone")).toBe(true);
    expect(setupAnswerEditable({ ...update, operation: "configure" }, "name")).toBe(true);
  });

  it("submits the exact preview token and selected immutable release", () => {
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

  it("preserves an explicit add agent id from preview through apply", () => {
    expect(
      buildClawApplyRequest({
        pending: {
          operation: "add",
          source: { packageName: "financial-analyst", version: "1.2.0" },
          agentId: "quarterly-analyst",
        },
        plan: {
          ...plan,
          operation: "add",
          target: { agentId: "quarterly-analyst" },
          riskAcknowledgementRequired: false,
        },
        removeUnused: false,
        riskAcknowledged: false,
      }),
    ).toEqual({
      method: "claws.add.apply",
      request: {
        source: { packageName: "financial-analyst", version: "1.2.0" },
        agentId: "quarterly-analyst",
        planIntegrity: "sha256:exact-preview-token",
      },
    });
  });

  it("does not construct a mutation request before required consent", () => {
    expect(
      buildClawApplyRequest({
        pending: { operation: "update", target: "analyst" },
        plan,
        removeUnused: false,
        riskAcknowledged: false,
      }),
    ).toBeNull();
  });

  it("binds configure answers and seed regeneration to the previewed request", () => {
    expect(
      buildClawApplyRequest({
        pending: {
          operation: "configure",
          target: "analyst",
          answers: { timezone: "America/Los_Angeles", concise: true },
          clearAnswers: ["briefingHour"],
          regenerateSeeds: ["PREFERENCES.md"],
        },
        plan: { ...plan, operation: "configure", riskAcknowledgementRequired: false },
        removeUnused: false,
        riskAcknowledged: false,
      }),
    ).toEqual({
      method: "claws.configure.apply",
      request: {
        target: "analyst",
        answers: { timezone: "America/Los_Angeles", concise: true },
        clearAnswers: ["briefingHour"],
        regenerateSeeds: ["PREFERENCES.md"],
        planIntegrity: "sha256:exact-preview-token",
      },
    });
  });

  it("does not construct a request for a blocked or mismatched preview", () => {
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
        plan: {
          ...plan,
          blockers: [{ code: "changed", path: "$", message: "Preview again." }],
        },
        removeUnused: false,
        riskAcknowledged: true,
      }),
    ).toBeNull();
  });
});
