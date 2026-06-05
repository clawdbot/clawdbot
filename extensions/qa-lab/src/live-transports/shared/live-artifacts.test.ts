// Qa Lab tests cover live artifacts plugin behavior.
import { describe, expect, it } from "vitest";
import { redactQaLiveLaneIssues } from "./live-artifacts.js";

describe("live transport artifacts", () => {
  it("preserves cleanup phase labels while redacting details", () => {
    expect(
      redactQaLiveLaneIssues([
        "credential lease release: broker rejected release for group -100123",
        "live gateway cleanup: failed to stop pid 123",
      ]),
    ).toEqual([
      "credential lease release: details redacted (OPENCLAW_QA_REDACT_PUBLIC_METADATA=1)",
      "live gateway cleanup: details redacted (OPENCLAW_QA_REDACT_PUBLIC_METADATA=1)",
    ]);
  });
});
