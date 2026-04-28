import { expect } from "vitest";

export function expectOpenDmPolicyConfigIssue<TAccount>(params: {
  collectIssues: (accounts: TAccount[]) => Array<{ kind?: string }>;
  account: TAccount;
}) {
  const issues = params.collectIssues([params.account]);
  expect(issues).toHaveLength(1);
  expect(issues[0]?.kind).toBe("config");
}
