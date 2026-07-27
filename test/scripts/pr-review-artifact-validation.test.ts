import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const reviewScript = join(process.cwd(), "scripts/pr-lib/review.sh");
const reviewArtifactsScript = join(process.cwd(), "scripts/pr-lib/review-artifacts.mjs");
const mergeScript = join(process.cwd(), "scripts/pr-lib/merge.sh");
const describePosix = process.platform === "win32" ? describe.skip : describe;

function validReview() {
  return {
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

function validReadyReview() {
  const review = validReview();
  review.recommendation = "READY FOR /prepare-pr";
  review.issueValidation.status = "valid";
  return review;
}

function runValidation(
  review: ReturnType<typeof validReview>,
  options: {
    files?: string[];
    guardFailure?: boolean;
    mode?: "pr" | "main";
    orList?: boolean;
  } = {},
) {
  const fixtureRoot = tempDirs.make("openclaw-pr-review-validation-");
  const localDir = join(fixtureRoot, ".local");
  mkdirSync(localDir);
  writeFileSync(join(localDir, "review.json"), `${JSON.stringify(review)}\n`);
  writeFileSync(
    join(localDir, "review.md"),
    ["A)", "B)", "C)", "D)", "E)", "F)", "G)", "H)", "I)", "J)"].join("\n"),
  );
  writeFileSync(join(localDir, "pr-meta.env"), "PR_URL=https://example.invalid/pr/42\n");
  writeFileSync(
    join(localDir, "pr-meta.json"),
    `${JSON.stringify({ files: (options.files ?? []).map((path) => ({ path })) })}\n`,
  );

  return spawnSync(
    "bash",
    [
      "-c",
      [
        "set -euo pipefail",
        'source "$1"',
        'fixture_root="$2"',
        'enter_worktree() { cd "$fixture_root"; }',
        'require_artifact() { [ -s "$1" ]; }',
        options.guardFailure
          ? "review_guard() { REVIEW_MODE=pr; echo 'review head guard failed'; return 1; }"
          : `review_guard() { REVIEW_MODE=${options.mode ?? "pr"}; }`,
        "print_review_stdout_summary() { :; }",
        options.orList ? "review_validate_artifacts 42 || exit 1" : "review_validate_artifacts 42",
      ].join("\n"),
      "pr-review-artifact-validation",
      reviewScript,
      fixtureRoot,
    ],
    { encoding: "utf8" },
  );
}

function runMergeVerification(checks: "api-error" | "invalid-json" | "no-required" | "pending") {
  const fixtureRoot = tempDirs.make("openclaw-pr-merge-verification-");
  const localDir = join(fixtureRoot, ".local");
  const head = "a".repeat(40);
  mkdirSync(localDir);
  writeFileSync(join(localDir, "prep.env"), `PREP_HEAD_SHA=${head}\n`);

  const checksResponse =
    checks === "api-error"
      ? "echo 'GitHub API unavailable' >&2; return 1"
      : checks === "no-required"
        ? "echo \"no required checks reported on the 'review-branch' branch\" >&2; return 1"
        : checks === "pending"
          ? `printf '%s\\n' '[{"name":"CI","bucket":"pending","state":"IN_PROGRESS"}]'; return 8`
          : "printf '%s\\n' 'not valid JSON'";

  return spawnSync(
    "bash",
    [
      "-c",
      [
        "set -euo pipefail",
        'source "$1"',
        'fixture_root="$2"',
        'enter_worktree() { cd "$fixture_root"; }',
        'require_artifact() { [ -s "$1" ]; }',
        "verify_prep_branch_matches_prepared_head() { :; }",
        `pr_meta_json() { printf '%s\\n' '{"isDraft":false,"headRefOid":"${head}"}'; }`,
        "mark_pr_operation_side_effects_started() { :; }",
        "git() { :; }",
        `gh() { case "$*" in *"--json name,bucket,state"*) ${checksResponse};; *) return 0;; esac; }`,
        "merge_verify 42",
      ].join("\n"),
      "pr-merge-verification",
      mergeScript,
      fixtureRoot,
    ],
    { encoding: "utf8" },
  );
}

describePosix("scripts/pr review artifact validation", () => {
  it("accepts a valid review artifact", () => {
    const result = runValidation(validReview());

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("review artifacts validated");
  });

  it("rejects validation from main-baseline mode", () => {
    const result = runValidation(validReview(), { mode: "main" });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "Review artifact validation requires the reviewed PR head, not main-baseline mode.",
    );
  });

  it("preserves head-guard failures when preparation calls validation in an OR-list", () => {
    const result = runValidation(validReview(), { guardFailure: true, orList: true });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("review head guard failed");
    expect(result.stdout).not.toContain("review artifacts validated");
  });

  it.each(["BLOCKER", "IMPORTANT"] as const)(
    "rejects a ready review containing a %s finding",
    (severity) => {
      const review = validReadyReview();
      review.findings.push({
        id: "review-finding",
        title: "Actionable review finding",
        area: "runtime",
        fix: "Resolve the finding before preparing the PR.",
        severity,
      });

      const result = runValidation(review);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        "READY FOR /prepare-pr cannot include BLOCKER or IMPORTANT findings",
      );
    },
  );

  it("keeps non-ready findings and failed proof valid for review triage", () => {
    const review = validReview();
    review.findings.push({
      id: "review-finding",
      title: "Actionable review finding",
      area: "runtime",
      fix: "Resolve the finding before preparing the PR.",
      severity: "IMPORTANT",
    });
    review.tests.result = "fail";

    const result = runValidation(review);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it("rejects a ready review with failing proof", () => {
    const review = validReadyReview();
    review.tests.result = "fail";

    const result = runValidation(review);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("READY FOR /prepare-pr cannot include failing tests");
  });

  it("permits documentation-only ready reviews without runtime tests", () => {
    const review = validReadyReview();
    review.tests.result = "not_run";

    const result = runValidation(review, { files: ["docs/reference/example.md"] });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it.each([
    "packages/normalization-core/src/string-normalization.ts",
    "packages/gateway-protocol/src/schema/approvals.ts",
    "ui/src/app.ts",
  ])("requires behavioral review for core runtime path %s", (path) => {
    const result = runValidation(validReview(), { files: [path] });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "runtime file changes require behavioralSweep.status=pass|needs_work",
    );
    expect(result.stdout).toContain("runtime file changes require at least one branch entry");
  });

  it("requires passing runtime proof for a ready review", () => {
    const review = validReadyReview();
    review.behavioralSweep.status = "pass";
    review.behavioralSweep.branches.push({
      path: "ui/src/app.ts",
      decision: "verified",
      outcome: "Behavior remains correct.",
    });
    review.tests.result = "not_run";

    const result = runValidation(review, { files: ["ui/src/app.ts"] });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "READY FOR /prepare-pr on runtime changes requires passing tests",
    );
  });

  it("rejects merge verification when GitHub cannot verify required checks", () => {
    const result = runMergeVerification("api-error");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unable to verify the required GitHub checks");
    expect(result.stderr).toContain("GitHub API unavailable");
    expect(result.stdout).not.toContain("merge-verify passed");
    expect(result.stdout).not.toContain("No required checks configured");
  });

  it("preserves GitHub CLI behavior when a branch has no required checks", () => {
    const result = runMergeVerification("no-required");

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("No required checks configured for this PR.");
    expect(result.stdout).toContain("merge-verify passed for PR #42");
  });

  it("preserves GitHub CLI pending-check evidence from exit status eight", () => {
    const result = runMergeVerification("pending");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Required checks are still pending.");
    expect(result.stderr).not.toContain("unable to verify the required GitHub checks");
    expect(result.stdout).not.toContain("merge-verify passed");
  });

  it("rejects merge verification when GitHub returns malformed check evidence", () => {
    const result = runMergeVerification("invalid-json");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GitHub returned invalid required-check evidence");
    expect(result.stdout).not.toContain("merge-verify passed");
  });

  it("reports the required branch entry shape without a raw jq error", () => {
    const review = validReview();
    review.behavioralSweep.branches = ["src/example.ts"];
    const result = runValidation(review);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "Invalid behavioral sweep branch entry in .local/review.json: each entry must be an object with string path/decision/outcome",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(
      'Cannot index string with string ("path")',
    );
  });

  it("lists allowed values for an invalid enum", () => {
    const review = validReview();
    review.behavioralSweep.status = "performed";
    const result = runValidation(review);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'Invalid behavioral sweep status in .local/review.json: "performed" (allowed: pass|needs_work|not_applicable)',
    );
  });

  it("reports every artifact violation before exiting", () => {
    const review = validReview();
    review.behavioralSweep.status = "performed";
    review.behavioralSweep.branches = "src/example.ts" as unknown as unknown[];
    review.docs = "todo";
    const result = runValidation(review);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'Invalid behavioral sweep status in .local/review.json: "performed" (allowed: pass|needs_work|not_applicable)',
    );
    expect(result.stdout).toContain(
      "Invalid behavioral sweep in .local/review.json: behavioralSweep.branches must be an array",
    );
    expect(result.stdout).toContain(
      'Invalid docs status in .local/review.json: "todo" (allowed: up_to_date|missing|not_applicable)',
    );
    expect(result.stdout).toContain("3 artifact violations");
  });

  it("derives template enum hints from the validation table", () => {
    const result = spawnSync(process.execPath, [reviewArtifactsScript, "template"], {
      encoding: "utf8",
    });
    const template = JSON.parse(result.stdout) as ReturnType<typeof validReview>;

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(template.recommendation).toBe(
      "NEEDS WORK (allowed: READY FOR /prepare-pr|NEEDS WORK|NEEDS DISCUSSION|NOT USEFUL (CLOSE))",
    );
    expect(template.nitSweep.status).toBe("none (allowed: none|has_nits)");
    expect(template.behavioralSweep.status).toBe(
      "not_applicable (allowed: pass|needs_work|not_applicable)",
    );
    expect(template.behavioralSweep.silentDropRisk).toBe("none (allowed: none|present|unknown)");
    expect(template.issueValidation.source).toBe("pr_body (allowed: linked_issue|pr_body|both)");
    expect(template.issueValidation.status).toBe(
      "unclear (allowed: valid|unclear|invalid|already_fixed_on_main)",
    );
    expect(template.tests.result).toBe("pass (allowed: pass|fail|not_run)");
    expect(template.docs).toBe("not_applicable (allowed: up_to_date|missing|not_applicable)");
    expect(template.changelog).toBe("not_required (allowed: required|not_required)");
  });
});
