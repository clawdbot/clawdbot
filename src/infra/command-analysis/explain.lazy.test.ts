import { describe, expect, it, vi } from "vitest";

vi.mock("../command-explainer/extract.js", () => {
  throw new Error("command explainer should not load for lightweight summaries");
});

describe("command-analysis lazy command explainer", () => {
  it("does not load tree-sitter parser dependencies for policy summaries", async () => {
    const { resolveCommandAnalysisSummaryForDisplay } = await import("./explain.js");

    expect(
      resolveCommandAnalysisSummaryForDisplay({
        host: "gateway",
        commandText: "python3 -c 'print(1)'",
      }),
    ).toEqual(
      expect.objectContaining({
        commandCount: 1,
        riskKinds: ["inline-eval"],
        warningLines: ["Contains inline-eval: python3 -c"],
      }),
    );
  });
});
