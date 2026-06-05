// Classification coverage for compaction failure and skip reason telemetry.
import { describe, expect, it } from "vitest";
import {
  classifyCompactionReason,
  formatUnknownCompactionReasonDetail,
  resolveCompactionFailureReason,
} from "./compact-reasons.js";

describe("resolveCompactionFailureReason", () => {
  it("replaces generic compaction cancellation with the safeguard reason", () => {
    // Safeguard cancellation is the actionable root cause; preserving only the
    // generic cancellation text would hide the provider/auth failure.
    expect(
      resolveCompactionFailureReason({
        reason: "Compaction cancelled",
        safeguardCancelReason:
          "Compaction safeguard could not resolve an API key for anthropic/claude-opus-4-6.",
      }),
    ).toBe("Compaction safeguard could not resolve an API key for anthropic/claude-opus-4-6.");
  });

  it("preserves non-generic compaction failures", () => {
    expect(
      resolveCompactionFailureReason({
        reason: "Compaction timed out",
        safeguardCancelReason:
          "Compaction safeguard could not resolve an API key for anthropic/claude-opus-4-6.",
      }),
    ).toBe("Compaction timed out");
  });
});

describe("classifyCompactionReason", () => {
  it('classifies "nothing to compact" as a skip-like reason', () => {
    expect(classifyCompactionReason("Nothing to compact (session too small)")).toBe(
      "no_compactable_entries",
    );
  });

  it('classifies "already under target" as below threshold', () => {
    expect(classifyCompactionReason("already under target")).toBe("below_threshold");
  });

  it("classifies deferred background maintenance as a skip-like reason", () => {
    expect(classifyCompactionReason("deferred to background context-engine maintenance")).toBe(
      "deferred_background",
    );
  });

  it("classifies safeguard messages as guard-blocked", () => {
    expect(
      classifyCompactionReason(
        "Compaction safeguard could not resolve an API key for anthropic/claude-opus-4-6.",
      ),
    ).toBe("guard_blocked");
  });

  it("keeps unclassified provider errors in the stable unknown bucket", () => {
    expect(classifyCompactionReason("No API provider registered for api: ollama")).toBe("unknown");
  });
});

describe("formatUnknownCompactionReasonDetail", () => {
  it("formats unknown reasons as single-token diagnostic detail", () => {
    expect(formatUnknownCompactionReasonDetail("No API provider registered for api: ollama")).toBe(
      "No_API_provider_registered_for_api:_ollama",
    );
  });

  it("strips terminal escapes and log separators from unknown reasons", () => {
    // Unknown reason detail is embedded in metric tags, so strip control
    // characters and separators before exporting it.
    expect(
      formatUnknownCompactionReasonDetail("\u001b[31mNo API\u001b[0m provider = ollama\nnext"),
    ).toBe("No_API_provider_ollama_next");
  });

  it("omits empty unknown reason detail", () => {
    expect(formatUnknownCompactionReasonDetail(" \n\t ")).toBeUndefined();
  });

  it("limits unknown reason detail length", () => {
    expect(formatUnknownCompactionReasonDetail("x".repeat(120))).toHaveLength(100);
  });
});
