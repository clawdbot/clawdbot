import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const reviewScript = join(process.cwd(), "scripts/pr-lib/review.sh");
const reviewArtifactsScript = join(process.cwd(), "scripts/pr-lib/review-artifacts.mjs");
const describePosix = process.platform === "win32" ? describe.skip : describe;

function validReview() {
  return {
    recommendation: "NEEDS WORK",
    findings: [],
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

function runValidation(review: ReturnType<typeof validReview>) {
  const fixtureRoot = tempDirs.make("openclaw-pr-review-validation-");
  const localDir = join(fixtureRoot, ".local");
  mkdirSync(localDir);
  writeFileSync(join(localDir, "review.json"), `${JSON.stringify(review)}\n`);
  writeFileSync(
    join(localDir, "review.md"),
    ["A)", "B)", "C)", "D)", "E)", "F)", "G)", "H)", "I)", "J)"].join("\n"),
  );
  writeFileSync(join(localDir, "pr-meta.env"), "PR_URL=https://example.invalid/pr/42\n");
  writeFileSync(join(localDir, "pr-meta.json"), '{"files":[]}\n');

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
        "review_guard() { :; }",
        "print_review_stdout_summary() { :; }",
        "review_validate_artifacts 42",
      ].join("\n"),
      "pr-review-artifact-validation",
      reviewScript,
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
