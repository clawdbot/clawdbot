// Classification coverage for compaction failure and skip reason telemetry.
import { describe, expect, it } from "vitest";
import {
  classifyCompactionReason,
  formatUnknownCompactionReasonDetail,
  isBenignCompactionSkipResult,
  isBenignCompactionSkipReason,
  type CompactionReasonCode,
  isCompactionSkipCode,
  isCompactionSkipReason,
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

  it('classifies "already compacted" without implying recency', () => {
    expect(classifyCompactionReason("already compacted")).toBe("already_compacted");
  });

  it("classifies deferred background maintenance as a skip-like reason", () => {
    expect(classifyCompactionReason("deferred to background context-engine maintenance")).toBe(
      "deferred_background",
    );
  });

  it('classifies "no real conversation messages" as a skip-like reason', () => {
    // Closed-union shape: this code keeps the existing-substring-match behavior
    // of isLegitSkipReason / isCompactionSkipReason covered by the closed union.
    expect(classifyCompactionReason("No real conversation messages to compact")).toBe(
      "no_real_conversation_messages",
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

  it("classifies 'Unknown model: ...' as unknown_model", () => {
    // surfaces when DEFAULT_PROVIDER/DEFAULT_MODEL fallback hits an unsupported model
    // — e.g. volitional compaction without provider/model passed routes to openai/gpt-5.4
    expect(classifyCompactionReason("Unknown model: openai/gpt-5.4")).toBe("unknown_model");
    expect(classifyCompactionReason("unknown model: foo/bar")).toBe("unknown_model");
  });

  it("returns 'unknown' for an empty / missing reason", () => {
    expect(classifyCompactionReason()).toBe("unknown");
    expect(classifyCompactionReason("")).toBe("unknown");
  });

  it("return type is the closed CompactionReasonCode union", () => {
    // Compile-time: assigning to CompactionReasonCode forces the union shape.
    const code: CompactionReasonCode = classifyCompactionReason("nothing to compact");
    expect(code).toBe("no_compactable_entries");
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

describe("isCompactionSkipCode", () => {
  const ALL_CODES: ReadonlyArray<CompactionReasonCode> = [
    "unknown",
    "no_compactable_entries",
    "no_real_conversation_messages",
    "unknown_model",
    "below_threshold",
    "already_compacted",
    "live_context_still_exceeds_target",
    "guard_blocked",
    "summary_failed",
    "timeout",
    "provider_error_4xx",
    "provider_error_5xx",
  ];

  const SKIP_CODES = new Set<CompactionReasonCode>([
    "no_compactable_entries",
    "no_real_conversation_messages",
    "below_threshold",
    "already_compacted",
  ]);

  it.each(ALL_CODES)("classifies %s correctly as skip vs non-skip", (code) => {
    expect(isCompactionSkipCode(code)).toBe(SKIP_CODES.has(code));
  });

  it("isCompactionSkipReason wraps classifier + isCompactionSkipCode", () => {
    expect(isCompactionSkipReason("Nothing to compact")).toBe(true);
    expect(isCompactionSkipReason("Below threshold")).toBe(true);
    expect(isCompactionSkipReason("Already compacted recently")).toBe(true);
    expect(isCompactionSkipReason("No real conversation messages to compact")).toBe(true);

    expect(isCompactionSkipReason("Compaction timed out")).toBe(false);
    expect(isCompactionSkipReason("Unknown model: openai/foo")).toBe(false);
    expect(isCompactionSkipReason("guard_blocked")).toBe(false);
    expect(isCompactionSkipReason()).toBe(false);
    expect(isCompactionSkipReason("")).toBe(false);
  });
});
