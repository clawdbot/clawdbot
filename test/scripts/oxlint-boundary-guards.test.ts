import { spawnSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

const FIXTURES = "test/fixtures/oxlint-boundary-guards";
const cases = [
  {
    rule: "openclaw-boundaries/no-register-http-handler-call",
    violation: `${FIXTURES}/register-http-handler-violation.ts`,
    violations: 3,
  },
  {
    rule: "openclaw-boundaries/no-raw-window-open-call",
    violation: `${FIXTURES}/raw-window-open-violation.ts`,
    violations: 5,
  },
  {
    rule: "openclaw-boundaries/no-widen-then-assert",
    violation: `${FIXTURES}/widen-then-assert-violation.test.ts`,
    violations: 3,
  },
  {
    rule: "openclaw-boundaries/no-chained-type-assertions",
    violation: `${FIXTURES}/chained-type-assertions-violation.ts`,
    violations: 3,
  },
];

describe("oxlint boundary guards", () => {
  let diagnostics: Array<{ filename: string; code: string; severity: string }>;

  beforeAll(() => {
    const violation = spawnSync(
      process.execPath,
      [
        "scripts/run-oxlint.mjs",
        "--openclaw-focused-config",
        "--config",
        "config/oxlint/boundary-guards.json",
        "--format",
        "json",
        ...cases.map((testCase) => testCase.violation),
      ],
      { encoding: "utf8" },
    );
    expect(violation.error).toBeUndefined();
    expect(violation.status, violation.stderr).toBe(1);
    const report = JSON.parse(violation.stdout) as {
      diagnostics: typeof diagnostics;
      number_of_files: number;
    };
    expect(report.number_of_files).toBe(cases.length);
    diagnostics = report.diagnostics;
  });

  it.each(cases)("reports expected violations for $rule", (testCase) => {
    // A fixture can trigger sibling rules; match both its file and its owning rule.
    const matching = diagnostics.filter(
      (diagnostic) =>
        diagnostic.filename.replaceAll("\\", "/") === testCase.violation &&
        diagnostic.code === `${testCase.rule.replace("/", "(")})`,
    );
    expect(matching.map((diagnostic) => diagnostic.severity)).toEqual(
      Array(testCase.violations).fill("error"),
    );
  });
});
