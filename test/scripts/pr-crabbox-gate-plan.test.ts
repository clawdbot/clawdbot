import { describe, expect, it } from "vitest";
import {
  buildCrabboxGateCommand,
  crabboxGatePlanDigest,
  formatCrabboxGateCheckSummary,
  parseCrabboxGateCheckSummary,
} from "../../scripts/pr-lib/crabbox-gate-contract.mjs";
import { createCrabboxGatePlan } from "../../scripts/pr-lib/crabbox-gate-plan.mts";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const bootstrapSha256 = "c".repeat(64);
const workflowSha = "d".repeat(40);

describe("Crabbox PR-derived gate plan", () => {
  it("requires every executable changed path to contribute precise test targets", () => {
    expect(() =>
      createCrabboxGatePlan({
        baseSha,
        changedPaths: [
          { path: "scripts/pr", status: "M" },
          { path: "scripts/pr-lib/gates.sh", status: "M" },
        ],
        headSha,
        resolvePathPlan: (changedPath) =>
          changedPath === "scripts/pr"
            ? { mode: "targets", targets: ["test/scripts/pr-merge.test.ts"] }
            : { mode: "targets", targets: [] },
      }),
    ).toThrow(/no complete targeted test plan for scripts\/pr-lib\/gates\.sh/u);
  });

  it.each([
    { mode: "broad", targets: [] },
    {
      mode: "targets",
      skippedBroadFallbackPaths: ["scripts/pr"],
      targets: ["test/scripts/pr-merge.test.ts"],
    },
    { mode: "targets", targets: ["test/vitest/vitest.tooling.config.ts"] },
  ])("rejects incomplete or broad authorization plan %#", (pathPlan) => {
    expect(() =>
      createCrabboxGatePlan({
        baseSha,
        changedPaths: [{ path: "scripts/pr", status: "M" }],
        headSha,
        resolvePathPlan: () => pathPlan,
      }),
    ).toThrow();
  });

  it("allows zero test targets only for explicit docs and instruction surfaces", () => {
    expect(
      createCrabboxGatePlan({
        baseSha,
        changedPaths: [
          { path: "docs/ci.md", status: "M" },
          { path: "scripts/AGENTS.md", status: "M" },
        ],
        headSha,
        resolvePathPlan: () => {
          throw new Error("docs must not consult executable test routing");
        },
      }),
    ).toMatchObject({ targets: [] });
  });

  it("does not authorize an arbitrary broad PR with gate-only tests", () => {
    expect(() =>
      createCrabboxGatePlan({
        baseSha,
        changedPaths: [{ path: "package.json", status: "M" }],
        headSha,
      }),
    ).toThrow(/no complete targeted test plan for package\.json/u);
  });

  it("binds immutable proof into the command and publisher workflow into the summary", () => {
    const plan = createCrabboxGatePlan({
      baseSha,
      changedPaths: [{ path: "scripts/pr", status: "M" }],
      headSha,
      resolvePathPlan: () => ({
        mode: "targets",
        targets: ["test/scripts/pr-merge.test.ts"],
      }),
    });
    const digest = crabboxGatePlanDigest(plan);
    const command = buildCrabboxGateCommand(plan, bootstrapSha256);
    expect(command).toContain(`OPENCLAW_CRABBOX_GATE_BASE=${baseSha}`);
    expect(command).toContain(`OPENCLAW_CRABBOX_GATE_HEAD=${headSha}`);
    expect(command).not.toContain("OPENCLAW_CRABBOX_GATE_WORKFLOW=");
    expect(command).toContain(`OPENCLAW_CRABBOX_GATE_PLAN_SHA256=${digest}`);
    expect(command).toContain("test/scripts/pr-merge.test.ts");

    const summary = formatCrabboxGateCheckSummary({
      baseSha,
      headSha,
      leaseId: "cbx_def456",
      planDigest: digest,
      runId: "run_abc123",
      targetCount: 1,
      workflowSha,
    });
    expect(parseCrabboxGateCheckSummary(summary)).toEqual({
      baseSha,
      headSha,
      leaseId: "cbx_def456",
      planDigest: digest,
      runId: "run_abc123",
      targetCount: 1,
      workflowSha,
    });
  });
});
