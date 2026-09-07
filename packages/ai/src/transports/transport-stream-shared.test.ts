import { describe, expect, it } from "vitest";
import {
  finalizeTerminalToolCallArguments,
  parseTerminalToolCallArguments,
} from "./transport-stream-shared.js";

const MALFORMED_TOOL_CALL_TERMINAL_ERROR_MESSAGE =
  "Provider completed tool call with malformed JSON arguments";

describe("parseTerminalToolCallArguments", () => {
  it("preserves unsafe integer literals in complete object arguments", () => {
    expect(parseTerminalToolCallArguments('{"target":9223372036854775807,"safe":42}')).toEqual({
      target: "9223372036854775807",
      safe: 42,
    });
    expect(parseTerminalToolCallArguments({})).toEqual({});
  });

  it("repairs raw control characters inside complete string values", () => {
    // Fine-grained tool streaming can deliver a finished block whose string values
    // contain literal newlines/tabs instead of \n / \t escapes.
    expect(parseTerminalToolCallArguments('{"path":"a.py","newText":"x = 1\ny = 2\tend"}')).toEqual(
      { path: "a.py", newText: "x = 1\ny = 2\tend" },
    );
  });

  it("repairs invalid escapes by preserving the backslash the model meant", () => {
    // JS string is: {"command":"grep -E \d+ file"} — an unescaped regex backslash.
    expect(parseTerminalToolCallArguments('{"command":"grep -E \\d+ file"}')).toEqual({
      command: "grep -E \\d+ file",
    });
  });

  it("keeps unsafe integers intact when a repair was needed", () => {
    expect(parseTerminalToolCallArguments('{"id":9223372036854775807,"note":"a\nb"}')).toEqual({
      id: "9223372036854775807",
      note: "a\nb",
    });
  });

  it.each(["", "   ", '{"secret":"do-not-echo"', "[]", "null", null])(
    "rejects non-object or malformed terminal input %# without exposing it",
    (value) => {
      let thrown: unknown;
      try {
        parseTerminalToolCallArguments(value);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ message: MALFORMED_TOOL_CALL_TERMINAL_ERROR_MESSAGE });
      expect(String(thrown)).not.toContain("do-not-echo");
      expect(JSON.stringify((thrown as Error).cause ?? null)).not.toContain("do-not-echo");
    },
  );

  it("attaches privacy-safe diagnostics as the error cause", () => {
    const truncated = '{"secret":"do-not-echo"';
    let thrown: unknown;
    try {
      parseTerminalToolCallArguments(truncated);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).cause).toEqual({
      code: "malformed_tool_call_arguments",
      argumentChars: truncated.length,
      argumentHash: expect.stringMatching(/^[0-9a-z]+$/),
      repairAttempted: true,
    });
  });
});

describe("finalizeTerminalToolCallArguments", () => {
  it("repairs a sibling call without touching already-valid siblings", () => {
    const calls = [
      {
        name: "read",
        arguments: {} as Record<string, unknown>,
        partialJson: '{"path":"README.md"}',
      },
      {
        name: "edit",
        arguments: {} as Record<string, unknown>,
        partialJson: '{"path":"a.py","newText":"x\ny"}',
      },
    ];
    finalizeTerminalToolCallArguments(calls, (call) => call.partialJson);
    expect(calls[0]?.arguments).toEqual({ path: "README.md" });
    expect(calls[1]?.arguments).toEqual({ path: "a.py", newText: "x\ny" });
  });

  it("does not mutate any sibling when one call stays malformed", () => {
    const calls = [
      {
        name: "read",
        arguments: {} as Record<string, unknown>,
        partialJson: '{"path":"README.md"}',
      },
      {
        name: "read",
        arguments: {} as Record<string, unknown>,
        partialJson: '{"path":"SECRET.md"',
      },
    ];
    expect(() => finalizeTerminalToolCallArguments(calls, (call) => call.partialJson)).toThrow(
      MALFORMED_TOOL_CALL_TERMINAL_ERROR_MESSAGE,
    );
    expect(calls[0]?.arguments).toEqual({});
    expect(calls[1]?.arguments).toEqual({});
  });
});
