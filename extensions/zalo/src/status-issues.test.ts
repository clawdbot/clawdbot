import { describe, it } from "vitest";
import { expectOpenDmPolicyConfigIssue } from "../../../test/helpers/plugins/status-issues.js";
import { collectZaloStatusIssues } from "./status-issues.js";

describe("collectZaloStatusIssues", () => {
  it("warns when dmPolicy is open", () => {
    expectOpenDmPolicyConfigIssue({
      collectIssues: collectZaloStatusIssues,
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        dmPolicy: "open",
      },
    });
  });
});
