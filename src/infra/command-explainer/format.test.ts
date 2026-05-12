import { describe, expect, it } from "vitest";
import { explainShellCommand } from "./extract.js";
import { formatCommandSpans } from "./format.js";
import type { CommandExplanation, SourceSpan } from "./types.js";

function span(startIndex: number, endIndex: number): SourceSpan {
  return {
    startIndex,
    endIndex,
    startPosition: { row: 0, column: startIndex },
    endPosition: { row: 0, column: endIndex },
  };
}

describe("formatCommandSpans", () => {
  it("returns executable token spans without risk or severity metadata", () => {
    const explanation: CommandExplanation = {
      ok: true,
      source: 'ls | grep "stuff" | python -c \'print("hi")\'',
      shapes: ["pipeline"],
      topLevelCommands: [
        {
          context: "top-level",
          executable: "ls",
          argv: ["ls"],
          text: "ls",
          span: span(0, 2),
          executableSpan: span(0, 2),
        },
        {
          context: "top-level",
          executable: "grep",
          argv: ["grep", "stuff"],
          text: 'grep "stuff"',
          span: span(5, 17),
          executableSpan: span(5, 9),
        },
        {
          context: "top-level",
          executable: "python",
          argv: ["python", "-c", 'print("hi")'],
          text: "python -c 'print(\"hi\")'",
          span: span(20, 42),
          executableSpan: span(20, 26),
        },
      ],
      nestedCommands: [],
      risks: [
        {
          kind: "inline-eval",
          command: "python",
          flag: "-c",
          text: "python -c 'print(\"hi\")'",
          span: span(20, 42),
        },
      ],
    };

    expect(formatCommandSpans(explanation)).toEqual([
      { startIndex: 0, endIndex: 2 },
      { startIndex: 5, endIndex: 9 },
      { startIndex: 20, endIndex: 26 },
    ]);
  });

  it("anchors command spans to executable tokens after env assignments", async () => {
    const explanation = await explainShellCommand("FOO=1 python -c 'print(1)'");

    expect(formatCommandSpans(explanation)).toContainEqual({ startIndex: 6, endIndex: 12 });
  });

  it("includes nested executable spans from shell wrapper payloads", async () => {
    const explanation = await explainShellCommand(
      'sh -c \'echo checking "$1"; node -e "console.log(process.argv[1])" "$1"\' sh file.ts',
    );

    const commandTexts = formatCommandSpans(explanation).map((commandSpan) =>
      explanation.source.slice(commandSpan.startIndex, commandSpan.endIndex),
    );
    expect(commandTexts).toContain("sh");
    expect(commandTexts).toContain("echo");
    expect(commandTexts).toContain("node");
  });

  it("omits command spans for unsupported shell wrapper languages", async () => {
    const powershell = await explainShellCommand('pwsh -Command "Get-ChildItem"');
    const cmd = await explainShellCommand('cmd.exe /d /s /c "dir"');

    expect(formatCommandSpans(powershell)).toEqual([]);
    expect(formatCommandSpans(cmd)).toEqual([]);
  });

  it("omits command spans for unsupported shell wrappers through transparent carriers", async () => {
    const timeoutPowershell = await explainShellCommand('timeout 5 pwsh -Command "Get-ChildItem"');
    const timeCmd = await explainShellCommand('time cmd.exe /d /s /c "dir"');
    const splitEnvPowershell = await explainShellCommand("env -S 'pwsh -Command Get-ChildItem'");

    expect(formatCommandSpans(timeoutPowershell)).toEqual([]);
    expect(formatCommandSpans(timeCmd)).toEqual([]);
    expect(formatCommandSpans(splitEnvPowershell)).toEqual([]);
  });

  it("ignores invalid executable spans", () => {
    const explanation: CommandExplanation = {
      ok: true,
      source: "echo hi",
      shapes: [],
      topLevelCommands: [
        {
          context: "top-level",
          executable: "echo",
          argv: ["echo", "hi"],
          text: "echo hi",
          span: span(0, 7),
          executableSpan: span(4, 4),
        },
      ],
      nestedCommands: [],
      risks: [],
    };

    expect(formatCommandSpans(explanation)).toStrictEqual([]);
  });
});
