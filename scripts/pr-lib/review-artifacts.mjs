#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { isDirectRunUrl } from "../lib/direct-run.mjs";

const REVIEW_ARTIFACT_ENUMS = Object.freeze({
  recommendation: Object.freeze([
    "READY FOR /prepare-pr",
    "NEEDS WORK",
    "NEEDS DISCUSSION",
    "NOT USEFUL (CLOSE)",
  ]),
  findingSeverity: Object.freeze(["BLOCKER", "IMPORTANT", "NIT"]),
  nitSweepStatus: Object.freeze(["none", "has_nits"]),
  issueValidationSource: Object.freeze(["linked_issue", "pr_body", "both"]),
  issueValidationStatus: Object.freeze(["valid", "unclear", "invalid", "already_fixed_on_main"]),
  behavioralSweepStatus: Object.freeze(["pass", "needs_work", "not_applicable"]),
  behavioralSweepRisk: Object.freeze(["none", "present", "unknown"]),
  testsResult: Object.freeze(["pass", "fail", "not_run"]),
  docs: Object.freeze(["up_to_date", "missing", "not_applicable"]),
  changelog: Object.freeze(["required", "not_required"]),
});

function reviewArtifactEnumHint(enumName, initialValue) {
  const allowed = REVIEW_ARTIFACT_ENUMS[enumName];
  if (!allowed?.includes(initialValue)) {
    throw new Error(`Invalid initial value ${initialValue} for review enum ${enumName}.`);
  }
  return `${initialValue} (allowed: ${allowed.join("|")})`;
}

function createReviewArtifactTemplate() {
  return {
    recommendation: reviewArtifactEnumHint("recommendation", "NEEDS WORK"),
    findings: [],
    nitSweep: {
      performed: true,
      status: reviewArtifactEnumHint("nitSweepStatus", "none"),
      summary: "No optional nits identified.",
    },
    behavioralSweep: {
      performed: true,
      status: reviewArtifactEnumHint("behavioralSweepStatus", "not_applicable"),
      summary: "No runtime branch-level behavior changes require sweep evidence.",
      silentDropRisk: reviewArtifactEnumHint("behavioralSweepRisk", "none"),
      branches: [],
    },
    issueValidation: {
      performed: true,
      source: reviewArtifactEnumHint("issueValidationSource", "pr_body"),
      status: reviewArtifactEnumHint("issueValidationStatus", "unclear"),
      summary: "Review not completed yet.",
    },
    tests: {
      ran: [],
      gaps: [],
      result: reviewArtifactEnumHint("testsResult", "pass"),
    },
    docs: reviewArtifactEnumHint("docs", "not_applicable"),
    changelog: reviewArtifactEnumHint("changelog", "not_required"),
  };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function jsonValue(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function validateReviewArtifacts({ review, reviewMarkdown, prMeta }) {
  const violations = [];
  const add = (message) => {
    if (!violations.includes(message)) {
      violations.push(message);
    }
  };
  const requireType = (valid, message) => {
    if (!valid) {
      add(message);
    }
    return valid;
  };
  const requireEnum = (value, enumName, messagePrefix) => {
    const allowed = REVIEW_ARTIFACT_ENUMS[enumName];
    if (!allowed.includes(value)) {
      add(`${messagePrefix}: ${jsonValue(value)} (allowed: ${allowed.join("|")})`);
      return false;
    }
    return true;
  };

  const reviewIsObject = requireType(
    isObject(review),
    "Invalid .local/review.json: top-level value must be an object",
  );
  const value = reviewIsObject ? review : {};
  const recommendationIsString = requireType(
    typeof value.recommendation === "string",
    "Invalid recommendation in .local/review.json: recommendation must be a string",
  );
  const findingsAreArray = requireType(
    Array.isArray(value.findings),
    "Invalid findings in .local/review.json: findings must be an array",
  );
  const findings = findingsAreArray ? value.findings : [];
  requireType(
    findings.every(isObject),
    "Invalid finding entry in .local/review.json: each finding must be an object",
  );
  const nitSweepIsObject = requireType(
    isObject(value.nitSweep),
    "Invalid nit sweep in .local/review.json: nitSweep must be an object",
  );
  const issueValidationIsObject = requireType(
    isObject(value.issueValidation),
    "Invalid issue validation in .local/review.json: issueValidation must be an object",
  );
  const behavioralSweepIsObject = requireType(
    isObject(value.behavioralSweep),
    "Invalid behavioral sweep in .local/review.json: behavioralSweep must be an object",
  );
  const testsIsObject = requireType(
    isObject(value.tests),
    "Invalid tests in .local/review.json: tests must be an object",
  );

  for (const section of ["A)", "B)", "C)", "D)", "E)", "F)", "G)", "H)", "I)", "J)"]) {
    if (!reviewMarkdown.split("\n").some((line) => line.startsWith(section))) {
      add(`Missing section header in .local/review.md: ${section}`);
    }
  }

  if (recommendationIsString) {
    requireEnum(
      value.recommendation,
      "recommendation",
      "Invalid recommendation in .local/review.json",
    );
  }

  const invalidSeverity = findings.find(
    (finding) =>
      isObject(finding) && !REVIEW_ARTIFACT_ENUMS.findingSeverity.includes(finding.severity),
  );
  if (invalidSeverity) {
    add(
      `Invalid finding severity in .local/review.json: ${jsonValue(invalidSeverity.severity)} (allowed: ${REVIEW_ARTIFACT_ENUMS.findingSeverity.join("|")})`,
    );
  }
  if (
    findings.some(
      (finding) =>
        !isObject(finding) ||
        typeof finding.id !== "string" ||
        typeof finding.title !== "string" ||
        typeof finding.area !== "string" ||
        typeof finding.fix !== "string",
    )
  ) {
    add("Invalid finding shape in .local/review.json (id/title/area/fix must be strings)");
  }
  const nitFindingsCount = findings.filter(
    (finding) => isObject(finding) && finding.severity === "NIT",
  ).length;

  const nitSweep = nitSweepIsObject ? value.nitSweep : {};
  const nitSweepPerformedIsBoolean = requireType(
    typeof nitSweep.performed === "boolean",
    "Invalid nit sweep in .local/review.json: nitSweep.performed must be a boolean",
  );
  if (nitSweepPerformedIsBoolean && nitSweep.performed !== true) {
    add("Invalid nit sweep in .local/review.json: nitSweep.performed must be true");
  }
  const nitSweepStatusIsString = requireType(
    typeof nitSweep.status === "string",
    "Invalid nit sweep status in .local/review.json: nitSweep.status must be a string",
  );
  if (nitSweepStatusIsString) {
    const validStatus = requireEnum(
      nitSweep.status,
      "nitSweepStatus",
      "Invalid nit sweep status in .local/review.json",
    );
    if (validStatus && nitSweep.status === "none" && nitFindingsCount > 0) {
      add(
        "Invalid nit sweep in .local/review.json: nitSweep.status is none but NIT findings exist",
      );
    }
    if (validStatus && nitSweep.status === "has_nits" && nitFindingsCount < 1) {
      add(
        "Invalid nit sweep in .local/review.json: nitSweep.status is has_nits but no NIT findings exist",
      );
    }
  }
  requireType(
    typeof nitSweep.summary === "string",
    "Invalid nit sweep summary in .local/review.json: nitSweep.summary must be a string",
  );
  if (typeof nitSweep.summary === "string" && !isNonEmptyString(nitSweep.summary)) {
    add(
      "Invalid nit sweep summary in .local/review.json: nitSweep.summary must be a non-empty string",
    );
  }

  const issueValidation = issueValidationIsObject ? value.issueValidation : {};
  const issuePerformedIsBoolean = requireType(
    typeof issueValidation.performed === "boolean",
    "Invalid issue validation in .local/review.json: issueValidation.performed must be a boolean",
  );
  if (issuePerformedIsBoolean && issueValidation.performed !== true) {
    add("Invalid issue validation in .local/review.json: issueValidation.performed must be true");
  }
  const issueSourceIsString = requireType(
    typeof issueValidation.source === "string",
    "Invalid issue validation source in .local/review.json: issueValidation.source must be a string",
  );
  if (issueSourceIsString) {
    requireEnum(
      issueValidation.source,
      "issueValidationSource",
      "Invalid issue validation source in .local/review.json",
    );
  }
  const issueStatusIsString = requireType(
    typeof issueValidation.status === "string",
    "Invalid issue validation status in .local/review.json: issueValidation.status must be a string",
  );
  if (issueStatusIsString) {
    requireEnum(
      issueValidation.status,
      "issueValidationStatus",
      "Invalid issue validation status in .local/review.json",
    );
  }
  requireType(
    typeof issueValidation.summary === "string",
    "Invalid issue validation summary in .local/review.json: issueValidation.summary must be a string",
  );
  if (typeof issueValidation.summary === "string" && !isNonEmptyString(issueValidation.summary)) {
    add(
      "Invalid issue validation summary in .local/review.json: issueValidation.summary must be a non-empty string",
    );
  }

  const prMetaIsValid =
    isObject(prMeta) &&
    Array.isArray(prMeta.files) &&
    prMeta.files.every((file) => isObject(file) && typeof file.path === "string");
  if (!prMetaIsValid) {
    add("Invalid .local/pr-meta.json: files must be an array of objects with string path");
  }
  const runtimeFileCount = prMetaIsValid
    ? prMeta.files.filter(
        ({ path }) =>
          /^(src|extensions|apps)\//u.test(path) &&
          !/(^|\/)__tests__\/|\.test\.|\.spec\./u.test(path) &&
          !/\.(md|mdx)$/u.test(path),
      ).length
    : 0;
  const runtimeReviewRequired = runtimeFileCount > 0;

  const behavioralSweep = behavioralSweepIsObject ? value.behavioralSweep : {};
  const behavioralPerformedIsBoolean = requireType(
    typeof behavioralSweep.performed === "boolean",
    "Invalid behavioral sweep in .local/review.json: behavioralSweep.performed must be a boolean",
  );
  if (behavioralPerformedIsBoolean && behavioralSweep.performed !== true) {
    add("Invalid behavioral sweep in .local/review.json: behavioralSweep.performed must be true");
  }
  const behavioralStatusIsString = requireType(
    typeof behavioralSweep.status === "string",
    "Invalid behavioral sweep status in .local/review.json: behavioralSweep.status must be a string",
  );
  const behavioralStatusIsValid =
    behavioralStatusIsString &&
    requireEnum(
      behavioralSweep.status,
      "behavioralSweepStatus",
      "Invalid behavioral sweep status in .local/review.json",
    );
  const behavioralRiskIsString = requireType(
    typeof behavioralSweep.silentDropRisk === "string",
    "Invalid behavioral sweep risk in .local/review.json: behavioralSweep.silentDropRisk must be a string",
  );
  const behavioralRiskIsValid =
    behavioralRiskIsString &&
    requireEnum(
      behavioralSweep.silentDropRisk,
      "behavioralSweepRisk",
      "Invalid behavioral sweep risk in .local/review.json",
    );
  requireType(
    typeof behavioralSweep.summary === "string",
    "Invalid behavioral sweep summary in .local/review.json: behavioralSweep.summary must be a string",
  );
  if (typeof behavioralSweep.summary === "string" && !isNonEmptyString(behavioralSweep.summary)) {
    add(
      "Invalid behavioral sweep summary in .local/review.json: behavioralSweep.summary must be a non-empty string",
    );
  }
  const branchesAreArray = Array.isArray(behavioralSweep.branches);
  if (!branchesAreArray) {
    add(
      "Invalid behavioral sweep in .local/review.json: behavioralSweep.branches must be an array",
    );
  }
  const branches = branchesAreArray ? behavioralSweep.branches : [];
  if (
    branches.some(
      (branch) =>
        !isObject(branch) ||
        typeof branch.path !== "string" ||
        typeof branch.decision !== "string" ||
        typeof branch.outcome !== "string",
    )
  ) {
    add(
      "Invalid behavioral sweep branch entry in .local/review.json: each entry must be an object with string path/decision/outcome",
    );
  }

  if (
    behavioralStatusIsValid &&
    runtimeReviewRequired &&
    behavioralSweep.status === "not_applicable"
  ) {
    add(
      "Invalid behavioral sweep in .local/review.json: runtime file changes require behavioralSweep.status=pass|needs_work",
    );
  }
  if (runtimeReviewRequired && branches.length < 1) {
    add(
      "Invalid behavioral sweep in .local/review.json: runtime file changes require at least one branch entry",
    );
  }
  if (
    behavioralStatusIsValid &&
    behavioralSweep.status === "not_applicable" &&
    branches.length > 0
  ) {
    add(
      "Invalid behavioral sweep in .local/review.json: not_applicable cannot include branch entries",
    );
  }
  if (
    behavioralStatusIsValid &&
    behavioralRiskIsValid &&
    behavioralSweep.status === "pass" &&
    behavioralSweep.silentDropRisk !== "none"
  ) {
    add("Invalid behavioral sweep in .local/review.json: status=pass requires silentDropRisk=none");
  }

  if (value.recommendation === "READY FOR /prepare-pr" && issueValidation.status !== "valid") {
    add(
      "Invalid recommendation in .local/review.json: READY FOR /prepare-pr requires issueValidation.status=valid",
    );
  }
  if (value.recommendation === "READY FOR /prepare-pr" && behavioralSweep.status === "needs_work") {
    add(
      "Invalid recommendation in .local/review.json: READY FOR /prepare-pr requires behavioralSweep.status!=needs_work",
    );
  }
  if (
    value.recommendation === "READY FOR /prepare-pr" &&
    runtimeReviewRequired &&
    behavioralSweep.status !== "pass"
  ) {
    add(
      "Invalid recommendation in .local/review.json: READY FOR /prepare-pr on runtime changes requires behavioralSweep.status=pass",
    );
  }
  if (
    value.recommendation === "READY FOR /prepare-pr" &&
    behavioralSweep.silentDropRisk === "present"
  ) {
    add(
      "Invalid recommendation in .local/review.json: READY FOR /prepare-pr is not allowed when behavioralSweep.silentDropRisk=present",
    );
  }

  const tests = testsIsObject ? value.tests : {};
  const testsRanAreArray = requireType(
    Array.isArray(tests.ran),
    "Invalid tests in .local/review.json: tests.ran must be an array of strings",
  );
  if (testsRanAreArray && !tests.ran.every((entry) => typeof entry === "string")) {
    add("Invalid tests in .local/review.json: tests.ran must be an array of strings");
  }
  const testsGapsAreArray = requireType(
    Array.isArray(tests.gaps),
    "Invalid tests in .local/review.json: tests.gaps must be an array of strings",
  );
  if (testsGapsAreArray && !tests.gaps.every((entry) => typeof entry === "string")) {
    add("Invalid tests in .local/review.json: tests.gaps must be an array of strings");
  }
  const testsResultIsString = requireType(
    typeof tests.result === "string",
    "Invalid tests result in .local/review.json: tests.result must be a string",
  );
  if (testsResultIsString) {
    requireEnum(tests.result, "testsResult", "Invalid tests result in .local/review.json");
  }

  const docsIsString = requireType(
    typeof value.docs === "string",
    "Invalid docs status in .local/review.json: docs must be a string",
  );
  if (docsIsString) {
    requireEnum(value.docs, "docs", "Invalid docs status in .local/review.json");
  }
  const changelogIsString = requireType(
    typeof value.changelog === "string",
    "Invalid changelog status in .local/review.json: changelog must be a string",
  );
  if (changelogIsString) {
    requireEnum(value.changelog, "changelog", "Invalid changelog status in .local/review.json");
  }

  return violations;
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${filePath}: ${message}`, { cause: error });
  }
}

function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (command === "template" && args.length === 0) {
    process.stdout.write(`${JSON.stringify(createReviewArtifactTemplate(), null, 2)}\n`);
    return;
  }
  if (command === "validate" && args.length === 3) {
    const [reviewPath, reviewMarkdownPath, prMetaPath] = args;
    const violations = validateReviewArtifacts({
      review: readJson(reviewPath),
      reviewMarkdown: readFileSync(reviewMarkdownPath, "utf8"),
      prMeta: readJson(prMetaPath),
    });
    if (violations.length > 0) {
      for (const violation of violations) {
        console.log(violation);
      }
      console.log(`${violations.length} artifact violations`);
      process.exitCode = 1;
    }
    return;
  }
  console.error(
    "Usage: review-artifacts.mjs template | validate <review.json> <review.md> <pr-meta.json>",
  );
  process.exitCode = 2;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
    console.log("1 artifact violations");
    process.exitCode = 1;
  }
}
