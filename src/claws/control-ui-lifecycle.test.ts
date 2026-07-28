import { describe, expect, it } from "vitest";
import { projectClawAddPlan, sealClawLifecyclePlan } from "./control-ui-lifecycle.js";
import type { ClawAddPlan } from "./types.js";

const projected = {
  operation: "add" as const,
  target: { agentId: "analyst", name: "financial-analyst", targetVersion: "1.0.0" },
  actions: [{ kind: "workspaceFile", id: "SOUL.md", action: "add", blocked: false }],
  capabilities: [],
  blockers: [],
  riskAcknowledgementRequired: false,
};

describe("sealClawLifecyclePlan", () => {
  it("binds the secret-safe preview token to the full canonical plan", () => {
    const first = sealClawLifecyclePlan(projected, "sha256:canonical-content-a");
    const second = sealClawLifecyclePlan(projected, "sha256:canonical-content-b");

    expect(first.planIntegrity).not.toBe(second.planIntegrity);
    expect(JSON.stringify(first)).not.toContain("canonical-content-a");
  });

  it("projects setup descriptors and readiness owners without answer or environment values", () => {
    const result = projectClawAddPlan({
      schemaVersion: "openclaw.clawAddPlan.v1",
      planIntegrity: "sha256:canonical",
      claw: { name: "analyst", version: "1.0.0", integrity: "sha256:package" },
      agent: { finalId: "analyst" },
      actions: [],
      capabilityChanges: [],
      blockers: [],
      readiness: {
        ready: false,
        requirements: [
          { kind: "environment", mcpServer: "markets", name: "PRIVATE_MARKETS_TOKEN" },
          { kind: "oauth", mcpServer: "mail" },
        ],
      },
      setup: {
        schemaDigest: "sha256:schema",
        answerDigest: "sha256:answers",
        valid: true,
        inputs: [{ id: "timezone", label: "Timezone", type: "string", maxLength: 80 }],
        providedInputIds: ["timezone"],
        defaultedInputIds: [],
        missingOptionalInputIds: [],
        seeds: [
          {
            source: "templates/PREFERENCES.md",
            destination: "PREFERENCES.md",
            inputIds: ["timezone"],
            renderedByteLength: 42,
            digest: "sha256:rendered-secret",
            blocked: false,
          },
        ],
        diagnostics: [],
      },
    } as unknown as ClawAddPlan);

    expect(result.setup?.inputs[0]).toMatchObject({ id: "timezone", label: "Timezone" });
    expect(result.readiness?.requirements).toEqual([
      { kind: "environment", owner: "markets" },
      { kind: "oauth", owner: "mail" },
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("PRIVATE_MARKETS_TOKEN");
    expect(serialized).not.toContain("rendered-secret");
    expect(serialized).not.toContain("answerDigest");
  });
});
