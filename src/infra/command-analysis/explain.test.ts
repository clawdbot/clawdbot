import { describe, expect, it } from "vitest";
import { explainShellCommand } from "../command-explainer/index.js";
import {
  explainCommandForDisplay,
  resolveCommandAnalysisSummaryForDisplay,
  summarizeCommandExplanation,
  summarizeCommandSegmentsForDisplay,
} from "./explain.js";

describe("command-analysis explanation summary", () => {
  it("summarizes commands and risk kinds", async () => {
    const explanation = await explainShellCommand(`bash -lc 'python3 -c "print(1)"'`);
    const summary = summarizeCommandExplanation(explanation);

    expect(summary.commandCount).toBe(1);
    expect(summary.riskKinds).toEqual(["shell-wrapper", "inline-eval"]);
    expect(summary.warningLines).toEqual([
      "Contains shell-wrapper: bash -lc",
      "Contains inline-eval: python3 -c",
    ]);
  });

  it("loads the rich command explainer for rich display summaries", async () => {
    const result = await explainCommandForDisplay(`bash -lc 'python3 -c "print(1)"'`);

    expect(result?.summary.commandCount).toBe(1);
    expect(result?.summary.riskKinds).toEqual(["shell-wrapper", "inline-eval"]);
  });

  it("summarizes policy command segments without async parsing", () => {
    const summary = summarizeCommandSegmentsForDisplay([
      {
        raw: "sudo python3 -c 'print(1)'",
        argv: ["sudo", "python3", "-c", "print(1)"],
        resolution: null,
      },
    ]);

    expect(summary.commandCount).toBe(1);
    expect(summary.riskKinds).toEqual(["inline-eval"]);
    expect(summary.warningLines).toEqual(["Contains inline-eval: python3 -c"]);
  });

  it("resolves node display summaries from argv", () => {
    const summary = resolveCommandAnalysisSummaryForDisplay({
      host: "node",
      commandText: "python3 script.py",
      commandArgv: ["python3", "-c", "print(1)"],
    });
    expect(summary?.commandCount).toBe(1);
    expect(summary?.riskKinds).toEqual(["inline-eval"]);
    expect(summary?.warningLines).toEqual(["Contains inline-eval: python3 -c"]);

    expect(
      resolveCommandAnalysisSummaryForDisplay({
        host: "node",
        commandText: "python3 -c 'print(1)'",
      }),
    ).toBeNull();
  });

  it("resolves gateway display summaries from shell text even when argv is stale", () => {
    const summary = resolveCommandAnalysisSummaryForDisplay({
      host: "gateway",
      commandText: "python3 -c 'print(1)'",
      commandArgv: ["python3", "script.py"],
    });
    expect(summary?.commandCount).toBe(1);
    expect(summary?.riskKinds).toEqual(["inline-eval"]);
    expect(summary?.warningLines).toEqual(["Contains inline-eval: python3 -c"]);

    expect(
      resolveCommandAnalysisSummaryForDisplay({
        host: "gateway",
        commandText: "echo ok",
        commandArgv: ["python3", "-c", "print(1)"],
      })?.riskKinds,
    ).toStrictEqual([]);
    expect(
      resolveCommandAnalysisSummaryForDisplay({
        host: "gateway",
        commandText: "python3 -c 'print(1)'",
        sanitizeText: (value) => value.replaceAll("python3", "python"),
      })?.warningLines,
    ).toEqual(["Contains inline-eval: python -c"]);
  });
});
