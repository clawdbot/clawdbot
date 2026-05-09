import { describe, expect, it } from "vitest";
import { validateRuleMetadata } from "../../security/opengrep/check-rule-metadata.mjs";

const validRule = {
  id: "ghsa-1234-abcd-5678.source-rule",
  metadata: {
    ghsa: "GHSA-1234-ABCD-5678",
    "advisory-url": "https://github.com/openclaw/openclaw/security/advisories/GHSA-1234-ABCD-5678",
    "detector-bucket": "precise",
    "source-rule-id": "source-rule",
  },
};

describe("check-opengrep-rule-metadata", () => {
  it("accepts GHSA-backed rules with durable source metadata", () => {
    expect(validateRuleMetadata([validRule])).toStrictEqual([]);
  });

  it("requires source metadata on every compiled rule", () => {
    expect(
      validateRuleMetadata([
        {
          id: "ghsa-1234-abcd-5678.source-rule",
          metadata: {
            ghsa: "GHSA-1234-ABCD-5678",
            "detector-bucket": "precise",
          },
        },
      ]),
    ).toEqual([
      "ghsa-1234-abcd-5678.source-rule: missing metadata.advisory-url",
      "ghsa-1234-abcd-5678.source-rule: missing metadata.source-rule-id",
    ]);
  });

  it("accepts non-GHSA source-backed rules with durable source metadata", () => {
    expect(
      validateRuleMetadata([
        {
          id: "cve-2026-12345.source-rule",
          metadata: {
            "advisory-id": "CVE-2026-12345",
            "advisory-url": "https://example.test/advisories/CVE-2026-12345",
            "detector-bucket": "precise",
            "source-rule-id": "source-rule",
          },
        },
      ]),
    ).toStrictEqual([]);
  });

  it("keeps the source id, rule id, and GHSA advisory URL consistent", () => {
    expect(
      validateRuleMetadata([
        {
          ...validRule,
          metadata: {
            ...validRule.metadata,
            ghsa: "GHSA-9999-ABCD-5678",
            "advisory-url":
              "https://github.com/openclaw/openclaw/security/advisories/GHSA-1234-ABCD-5678",
          },
        },
      ]),
    ).toEqual([
      "ghsa-1234-abcd-5678.source-rule: source id in metadata (GHSA-9999-ABCD-5678) must match source id in rule id (ghsa-1234-abcd-5678)",
      "ghsa-1234-abcd-5678.source-rule: metadata.advisory-url must be https://github.com/openclaw/openclaw/security/advisories/GHSA-9999-ABCD-5678",
    ]);
  });
});
