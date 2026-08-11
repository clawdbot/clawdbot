// Classification coverage for compaction failure and skip reason telemetry.
import { describe, expect, it } from "vitest";
import {
  classifyCompactionReason,
  formatUnknownCompactionReasonDetail,
  isBenignCompactionSkipResult,
  isBenignCompactionSkipReason,
  PREFLIGHT_UNRESOLVED_OVERFLOW_REASON,
  resolveCompactionFailureReason,
  resolvePreflightRequiredCompactionReason,
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

  it('classifies "already compacted" without implying recency', () => {
    expect(classifyCompactionReason("already compacted")).toBe("already_compacted");
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

  it("classifies transcript persistence failures without losing them as unknown", () => {
    expect(
      classifyCompactionReason(
        "Session transcript entry was not persisted: compaction-1: session-rebound",
      ),
    ).toBe("transcript_persistence_failed");
  });

  it("keeps unclassified provider errors in the stable unknown bucket", () => {
    expect(classifyCompactionReason("No API provider registered for api: ollama")).toBe("unknown");
  });

  it.each([
    ["HTTP 400 invalid request", "provider_error_4xx"],
    ["error, status code: 400, message: invalid request", "provider_error_4xx"],
    ["Provider API error (429): too many requests", "provider_error_4xx"],
    ["OpenAI API error (500): upstream failed", "provider_error_5xx"],
    ["503 service unavailable", "provider_error_5xx"],
  ])("classifies guarded provider status %s", (reason, expected) => {
    expect(classifyCompactionReason(reason)).toBe(expected);
  });

  it.each([402, 404, 408, 413, 501, 521, 524, 529])(
    "does not expand the established provider bucket set to HTTP %i",
    (status) => {
      expect(classifyCompactionReason(`HTTP ${status} provider response`)).toBe("unknown");
    },
  );

  it.each([
    "request id req-4291 failed",
    "input length 14295 tokens exceeds the model limit",
    "model model-x-500-preview not found",
  ])("ignores embedded status-like numbers: %s", (reason) => {
    // FIXED(refactor-06): numeric payload text is not an HTTP status.
    expect(classifyCompactionReason(reason)).toBe("unknown");
  });

  it("preserves timeout precedence over its HTTP status bucket", () => {
    expect(classifyCompactionReason("504 Gateway Timeout")).toBe("timeout");
  });
});

describe("isBenignCompactionSkipReason", () => {
  it.each(["already under target", "already compacted"])(
    "keeps the established %s skip contract",
    (reason) => {
      expect(isBenignCompactionSkipReason(reason)).toBe(true);
    },
  );

  it("requires an explicit successful-result opt-in for empty transcripts", () => {
    const reason = "no real conversation messages";
    expect(isBenignCompactionSkipReason(reason)).toBe(false);
    expect(isBenignCompactionSkipResult({ ok: true, compacted: false, reason })).toBe(true);
    expect(isBenignCompactionSkipResult({ ok: false, compacted: false, reason })).toBe(false);
    expect(isBenignCompactionSkipResult({ ok: true, compacted: true, reason })).toBe(false);
  });

  it.each([undefined, "Compaction timed out", "No API provider registered for api: ollama"])(
    "does not hide the failure reason %s",
    (reason) => {
      expect(isBenignCompactionSkipResult({ ok: true, compacted: false, reason })).toBe(false);
    },
  );
});

describe("resolvePreflightRequiredCompactionReason", () => {
  it("rewrites already-compacted into an unresolved-overflow failure for required preflights", () => {
    // The budget gate only requires preflight after measuring the session over
    // budget, so "nothing new to compact" means fixed overhead, not a fine session.
    expect(
      resolvePreflightRequiredCompactionReason({
        reason: "Already compacted",
        preflightRequired: true,
      }),
    ).toBe(PREFLIGHT_UNRESOLVED_OVERFLOW_REASON);
    expect(classifyCompactionReason(PREFLIGHT_UNRESOLVED_OVERFLOW_REASON)).toBe(
      "live_context_still_exceeds_target",
    );
    expect(
      isBenignCompactionSkipResult({
        ok: false,
        compacted: false,
        reason: PREFLIGHT_UNRESOLVED_OVERFLOW_REASON,
      }),
    ).toBe(false);
  });

  it("keeps the benign already-compacted skip for non-required compaction", () => {
    expect(
      resolvePreflightRequiredCompactionReason({
        reason: "Already compacted",
        preflightRequired: false,
      }),
    ).toBe("Already compacted");
    expect(resolvePreflightRequiredCompactionReason({ reason: "Already compacted" })).toBe(
      "Already compacted",
    );
  });

  it("leaves other failure reasons untouched for required preflights", () => {
    expect(
      resolvePreflightRequiredCompactionReason({
        reason: "Compaction timed out",
        preflightRequired: true,
      }),
    ).toBe("Compaction timed out");
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
