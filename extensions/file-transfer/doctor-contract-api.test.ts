import { describe, expect, it } from "vitest";
import { legacyConfigRules } from "./doctor-contract-api.js";

describe("file-transfer Doctor handoff", () => {
  const rule = legacyConfigRules[0];

  it("reports legacy positive permissions with the exact migration command", () => {
    expect(rule?.match({ nodes: { node: { allowReadPaths: ["/tmp/report-*.txt"] } } })).toBe(true);
    expect(rule?.message).toContain("openclaw file-transfer approvals migrate");
  });

  it("does not report reviewed or deny-only policy", () => {
    expect(rule?.match({ policyVersion: 2, nodes: { node: { allowReadPaths: ["/**"] } } })).toBe(
      false,
    );
    expect(rule?.match({ nodes: { node: { denyPaths: ["**/.ssh/**"] } } })).toBe(false);
  });
});
