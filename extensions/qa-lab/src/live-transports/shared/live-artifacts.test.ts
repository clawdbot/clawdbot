// Qa Lab tests cover live artifacts plugin behavior.
import { describe, expect, it } from "vitest";
import { redactQaLiveLaneDetails, redactQaLiveLaneIssues } from "./live-artifacts.js";

describe("live transport artifacts", () => {
  it("uses a stable public metadata redaction marker", () => {
    expect(redactQaLiveLaneDetails()).toBe(
      "details redacted (OPENCLAW_QA_REDACT_PUBLIC_METADATA=1)",
    );
  });

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

  it("redacts multi-line artifact errors without preserving later section labels", () => {
    expect(
      redactQaLiveLaneIssues([
        [
          "WhatsApp QA failed before scenario completion.",
          "raw startup error with +15550000002",
          "Artifacts:",
          "- gatewayDebug: /tmp/openclaw-whatsapp-qa/gateway-debug",
        ].join("\n"),
      ]),
    ).toEqual(["details redacted (OPENCLAW_QA_REDACT_PUBLIC_METADATA=1)"]);
  });
});
