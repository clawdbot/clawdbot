import { describe, expect, it } from "vitest";
import { buildCompactionSummarizationInstructions } from "./compaction.js";

describe("compaction identifier policy", () => {
  it("defaults to strict identifier preservation", () => {
    const built = buildCompactionSummarizationInstructions();
    expect(built).toContain("Preserve all opaque identifiers exactly as written");
    expect(built).toContain("UUIDs");
    expect(built).not.toContain("tokens");
    expect(built).not.toContain("API keys");
  });

  it("can disable identifier preservation with off policy", () => {
    const built = buildCompactionSummarizationInstructions(undefined, {
      identifierPolicy: "off",
    });
    expect(built).toBeUndefined();
  });

  it("supports custom identifier instructions", () => {
    const built = buildCompactionSummarizationInstructions(undefined, {
      identifierPolicy: "custom",
      identifierInstructions: "Keep ticket IDs unchanged.",
    });

    expect(built).toContain("Keep ticket IDs unchanged.");
    expect(built).not.toContain("Preserve all opaque identifiers exactly as written");
  });

  it("falls back to strict text when custom policy is missing instructions", () => {
    const built = buildCompactionSummarizationInstructions(undefined, {
      identifierPolicy: "custom",
      identifierInstructions: "   ",
    });
    expect(built).toContain("Preserve all opaque identifiers exactly as written");
  });

  it("keeps custom focus text when identifier policy is off", () => {
    const built = buildCompactionSummarizationInstructions("Track release blockers.", {
      identifierPolicy: "off",
    });
    expect(built).toBe("Additional focus:\nTrack release blockers.");
  });
});
