import { describe, expect, it, vi } from "vitest";

vi.mock("../command-explainer/extract.js", () => {
  throw new Error("command explainer should not load for lightweight summaries");
});

describe("command-analysis lazy command explainer", () => {
  it("does not load tree-sitter parser dependencies for policy summaries", async () => {
    const { resolveCommandAnalysisSummaryForDisplay } = await import("./explain.js");

    const summary = resolveCommandAnalysisSummaryForDisplay({
      host: "gateway",
      commandText: "python3 -c 'print(1)'",
    });

    if (!summary) {
      throw new Error("expected command analysis summary");
    }
    expect(summary.commandCount).toBe(1);
    expect(summary.riskKinds).toEqual(["inline-eval"]);
    expect(summary.warningLines).toEqual(["Contains inline-eval: python3 -c"]);
  });
});
