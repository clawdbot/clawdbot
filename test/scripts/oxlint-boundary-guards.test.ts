import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

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
];

function runGuard(target: string) {
  return spawnSync(
    process.execPath,
    [
      "scripts/run-oxlint.mjs",
      "--openclaw-focused-config",
      "--config",
      "config/oxlint/boundary-guards.json",
      target,
    ],
    { encoding: "utf8" },
  );
}

describe("oxlint boundary guards", () => {
  it.each(cases)("matches legacy call-only semantics for $rule", (testCase) => {
    const violation = runGuard(testCase.violation);
    const output = `${violation.stdout}${violation.stderr}`;
    expect(violation.status).toBe(1);
    expect(output.split(`${testCase.rule.replace("/", "(")})`)).toHaveLength(
      testCase.violations + 1,
    );
  });
});
