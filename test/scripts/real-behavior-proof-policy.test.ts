import { describe, expect, it } from "vitest";
import {
  MOCK_ONLY_PROOF_LABEL,
  NEEDS_REAL_BEHAVIOR_PROOF_LABEL,
  PROOF_OVERRIDE_LABEL,
  evaluateRealBehaviorProof,
  labelsForRealBehaviorProof,
} from "../../scripts/github/real-behavior-proof-policy.mjs";

function externalPr(body: string, overrides: Record<string, unknown> = {}) {
  return {
    body,
    author_association: "CONTRIBUTOR",
    user: {
      login: "external-contributor",
      type: "User",
    },
    labels: [],
    ...overrides,
  };
}

function proofBody(evidence: string, overrides: Record<string, string> = {}) {
  const fields = {
    behavior: "Gateway startup no longer drops the configured Discord channel.",
    environment: "macOS 15.4, Node 24, local OpenClaw gateway with a redacted Discord token.",
    steps: "pnpm openclaw gateway restart, then pnpm openclaw gateway status",
    evidence,
    observedResult: "The gateway stayed connected and the Discord channel showed ready.",
    notTested: "No known gaps.",
    ...overrides,
  };
  return [
    "## Real behavior proof",
    "",
    `- Behavior or issue addressed: ${fields.behavior}`,
    `- Real environment tested: ${fields.environment}`,
    `- Exact steps or command run after this patch: ${fields.steps}`,
    `- Evidence after fix: ${fields.evidence}`,
    `- Observed result after fix: ${fields.observedResult}`,
    `- What was not tested: ${fields.notTested}`,
  ].join("\n");
}

describe("real-behavior-proof-policy", () => {
  it.each([
    "![after](https://github.com/user-attachments/assets/abc123)",
    "Linked artifact: https://github.com/openclaw/openclaw/actions/runs/123456789/artifacts/987654321",
    "Redacted runtime log: gateway connected Discord channel and delivered the reply.",
    ["Terminal transcript:", "```text", "$ openclaw gateway status", "discord ready", "```"].join(
      "\n",
    ),
  ])("passes external PRs with real after-fix evidence: %s", (evidence) => {
    const evaluation = evaluateRealBehaviorProof({
      pullRequest: externalPr(proofBody(evidence)),
    });

    expect(evaluation.status).toBe("passed");
    expect(labelsForRealBehaviorProof(evaluation)).toEqual([]);
  });

  it("fails external PRs without a real behavior proof section", () => {
    const evaluation = evaluateRealBehaviorProof({
      pullRequest: externalPr("## Summary\n\n- Fixed startup."),
    });

    expect(evaluation.status).toBe("missing");
    expect(labelsForRealBehaviorProof(evaluation)).toEqual([NEEDS_REAL_BEHAVIOR_PROOF_LABEL]);
  });

  it("fails external PRs that say the changed behavior was not tested", () => {
    const evaluation = evaluateRealBehaviorProof({
      pullRequest: externalPr(proofBody("not tested")),
    });

    expect(evaluation.status).toBe("missing");
    expect(labelsForRealBehaviorProof(evaluation)).toEqual([NEEDS_REAL_BEHAVIOR_PROOF_LABEL]);
  });

  it("fails external PRs whose proof is only tests, mocks, snapshots, lint, typecheck, or CI", () => {
    const evaluation = evaluateRealBehaviorProof({
      pullRequest: externalPr(
        proofBody("pnpm test passed and Vitest mocks cover the branch.", {
          steps: "pnpm test",
          observedResult: "CI passes.",
        }),
      ),
    });

    expect(evaluation.status).toBe("mock_only");
    expect(labelsForRealBehaviorProof(evaluation)).toEqual([MOCK_ONLY_PROOF_LABEL]);
  });

  it("fails external PRs whose only copied output is a fenced test or CI transcript", () => {
    const evaluation = evaluateRealBehaviorProof({
      pullRequest: externalPr(
        proofBody(["```text", "$ pnpm test", "CI passed with Vitest mocks", "```"].join("\n"), {
          steps: "pnpm test",
          observedResult: "CI passes.",
        }),
      ),
    });

    expect(evaluation.status).toBe("mock_only");
    expect(labelsForRealBehaviorProof(evaluation)).toEqual([MOCK_ONLY_PROOF_LABEL]);
  });

  it("fails external PRs whose terminal label only contains test or CI output", () => {
    const evaluation = evaluateRealBehaviorProof({
      pullRequest: externalPr(
        proofBody(
          [
            "Terminal transcript:",
            "```text",
            "$ pnpm test",
            "CI passed with Vitest mocks",
            "```",
          ].join("\n"),
          {
            steps: "pnpm test",
            observedResult: "CI passes.",
          },
        ),
      ),
    });

    expect(evaluation.status).toBe("mock_only");
    expect(labelsForRealBehaviorProof(evaluation)).toEqual([MOCK_ONLY_PROOF_LABEL]);
  });

  it("passes maintainer, bot, and override cases", () => {
    expect(
      evaluateRealBehaviorProof({
        pullRequest: externalPr("", { author_association: "MEMBER" }),
      }).status,
    ).toBe("skipped");
    expect(
      evaluateRealBehaviorProof({
        pullRequest: externalPr("", {
          user: {
            login: "renovate[bot]",
            type: "Bot",
          },
        }),
      }).status,
    ).toBe("skipped");
    expect(
      evaluateRealBehaviorProof({
        pullRequest: externalPr("", { labels: [{ name: PROOF_OVERRIDE_LABEL }] }),
      }).status,
    ).toBe("override");
  });
});
