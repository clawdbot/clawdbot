// Covers command-analysis summary formatting for parsed shell explanations and
// policy-only argv/shell segment analysis.
import { describe, expect, it } from "vitest";
import { resolveCommandAnalysisSummaryForDisplay } from "./explain.js";

describe("command-analysis explanation summary", () => {
  it("resolves node display summaries from argv", async () => {
    const summary = await resolveCommandAnalysisSummaryForDisplay({
      host: "node",
      commandText: "python3 script.py",
      commandArgv: ["python3", "-c", "print(1)"],
    });
    expect(summary?.commandCount).toBe(1);
    expect(summary?.riskKinds).toEqual(["inline-eval"]);
    expect(summary?.warningLines).toEqual(["Contains inline-eval: python3 -c"]);

    expect(
      await resolveCommandAnalysisSummaryForDisplay({
        host: "node",
        commandText: "python3 -c 'print(1)'",
      }),
    ).toBeNull();
  });

  it("resolves gateway display summaries from shell text even when argv is stale", async () => {
    const summary = await resolveCommandAnalysisSummaryForDisplay({
      host: "gateway",
      commandText: "python3 -c 'print(1)'",
      commandArgv: ["python3", "script.py"],
    });
    expect(summary?.commandCount).toBe(1);
    expect(summary?.riskKinds).toEqual(["inline-eval"]);
    expect(summary?.warningLines).toEqual(["Contains inline-eval: python3 -c"]);

    expect(
      (
        await resolveCommandAnalysisSummaryForDisplay({
          host: "gateway",
          commandText: "echo ok",
          commandArgv: ["python3", "-c", "print(1)"],
        })
      )?.riskKinds,
    ).toStrictEqual([]);
    expect(
      (
        await resolveCommandAnalysisSummaryForDisplay({
          host: "gateway",
          commandText: "python3 -c 'print(1)'",
          sanitizeText: (value) => value.replaceAll("python3", "python"),
        })
      )?.warningLines,
    ).toEqual(["Contains inline-eval: python -c"]);
  });
});
