/**
 * Shared assertions for channel status issue contract tests.
 */
import { expect } from "vitest";

/** Verifies that an open-DM policy issue is reported as a config issue. */
export function expectOpenDmPolicyConfigIssue<TAccount>(params: {
  collectIssues: (accounts: TAccount[]) => Array<{ kind?: string }>;
  account: TAccount;
}) {
  const issues = params.collectIssues([params.account]);
  expect(issues).toHaveLength(1);
  expect(issues[0]?.kind).toBe("config");
}
