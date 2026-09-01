import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REVIEWED_PR = 42;
export const REVIEWED_HEAD = "b".repeat(40);

export function validReview(headSha = REVIEWED_HEAD) {
  return {
    pr: { number: REVIEWED_PR, headSha },
    recommendation: "NEEDS WORK",
    findings: [] as Array<{
      id: string;
      title: string;
      area: string;
      fix: string;
      severity: "BLOCKER" | "IMPORTANT" | "NIT";
    }>,
    nitSweep: {
      performed: true,
      status: "none",
      summary: "No optional nits identified.",
    },
    behavioralSweep: {
      performed: true,
      status: "not_applicable",
      summary: "No runtime behavior changed.",
      silentDropRisk: "none",
      branches: [] as unknown[],
    },
    issueValidation: {
      performed: true,
      source: "pr_body",
      status: "unclear",
      summary: "Review fixture.",
    },
    tests: {
      ran: [],
      gaps: [],
      result: "pass",
    },
    docs: "not_applicable",
    changelog: "not_required",
  };
}

export type ReviewArtifactFixtureOptions = {
  files?: string[];
  markdownIdentityLine?: string;
  metaEnvPrNumber?: number;
  mode?: "pr" | "main";
  headSha?: string;
};

export function writeReviewArtifacts(
  fixtureRoot: string,
  review: ReturnType<typeof validReview>,
  options: ReviewArtifactFixtureOptions = {},
) {
  const headSha = options.headSha ?? REVIEWED_HEAD;
  const localDir = join(fixtureRoot, ".local");
  mkdirSync(localDir, { recursive: true });
  writeFileSync(join(localDir, "review.json"), `${JSON.stringify(review)}\n`);
  writeFileSync(
    join(localDir, "review.md"),
    [
      options.markdownIdentityLine ?? `Review artifact for PR #${REVIEWED_PR} at ${headSha}`,
      "A)",
      "B)",
      "C)",
      "D)",
      "E)",
      "F)",
      "G)",
      "H)",
      "I)",
      "J)",
    ].join("\n"),
  );
  writeFileSync(
    join(localDir, "pr-meta.env"),
    `PR_URL=https://example.invalid/pr/42\nPR_NUMBER=${options.metaEnvPrNumber ?? REVIEWED_PR}\nPR_HEAD_SHA=${headSha}\n`,
  );
  writeFileSync(
    join(localDir, "pr-meta.json"),
    `${JSON.stringify({
      number: REVIEWED_PR,
      headRefOid: headSha,
      files: (options.files ?? []).map((path) => ({ path })),
    })}\n`,
  );

  writeFileSync(join(localDir, "review-mode.env"), `REVIEW_MODE=${options.mode ?? "pr"}\n`);
}
