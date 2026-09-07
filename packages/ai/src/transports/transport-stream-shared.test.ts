import { describe, expect, it } from "vitest";
import {
  finalizeTerminalToolCallArguments,
  parseTerminalToolCallArguments,
} from "./transport-stream-shared.js";

const MALFORMED_TOOL_CALL_TERMINAL_ERROR_MESSAGE =
  "Provider completed tool call with malformed JSON arguments";
const REPAIR = { repairStringLiterals: true } as const;

function captureError(run: () => unknown): Error & { errorCode?: string; errorBody?: string } {
  try {
    run();
  } catch (error) {
    return error as Error & { errorCode?: string; errorBody?: string };
  }
  throw new Error("expected a throw");
}

describe("parseTerminalToolCallArguments", () => {
  it("preserves unsafe integer literals in complete object arguments", () => {
    expect(parseTerminalToolCallArguments('{"target":9223372036854775807,"safe":42}')).toEqual({
      target: "9223372036854775807",
      safe: 42,
    });
    expect(parseTerminalToolCallArguments({})).toEqual({});
  });

  it("stays strict by default: raw control characters are rejected without repair", () => {
    const thrown = captureError(() =>
      parseTerminalToolCallArguments('{"path":"a.py","newText":"x = 1\ny = 2"}'),
    );
    expect(thrown.message).toBe(MALFORMED_TOOL_CALL_TERMINAL_ERROR_MESSAGE);
    expect(thrown.cause).toMatchObject({ repairAttempted: false });
  });

  it("repairs raw control characters inside complete string values when opted in", () => {
    // Fine-grained tool streaming can deliver a finished block whose string values
    // contain literal newlines/tabs instead of \n / \t escapes.
    expect(
      parseTerminalToolCallArguments(
        '{"path":"a.py","newText":"x = 1\ny = 2\tend"}',
        undefined,
        REPAIR,
      ),
    ).toEqual({ path: "a.py", newText: "x = 1\ny = 2\tend" });
  });

  it("repairs invalid escapes by preserving the backslash the model meant", () => {
    // JS string is: {"command":"grep -E \d+ file"} — an unescaped regex backslash.
    expect(
      parseTerminalToolCallArguments('{"command":"grep -E \\d+ file"}', undefined, REPAIR),
    ).toEqual({ command: "grep -E \\d+ file" });
  });

  it("preserves valid control escapes in sibling fields, even after a path-like prefix", () => {
    // oldText legitimately contains a newline (a valid \n escape after "C:"); newText has a raw
    // newline that needs repair. The repair must not turn oldText into a literal backslash-n.
    const raw = '{"path":"C:\\\\app\\\\a.py","oldText":"C:\\nnext","newText":"x = 1\ny = 2"}';
    expect(parseTerminalToolCallArguments(raw, undefined, REPAIR)).toEqual({
      path: "C:\\app\\a.py",
      oldText: "C:\nnext",
      newText: "x = 1\ny = 2",
    });
  });

  it("keeps unsafe integers intact when a repair was needed", () => {
    expect(
      parseTerminalToolCallArguments('{"id":9223372036854775807,"note":"a\nb"}', undefined, REPAIR),
    ).toEqual({ id: "9223372036854775807", note: "a\nb" });
  });

  it.each(["", "   ", '{"secret":"do-not-echo"', "[]", "null", null])(
    "rejects non-object or malformed terminal input %# without exposing it",
    (value) => {
      for (const options of [undefined, REPAIR]) {
        const thrown = captureError(() =>
          parseTerminalToolCallArguments(value, undefined, options),
        );
        expect(thrown).toMatchObject({ message: MALFORMED_TOOL_CALL_TERMINAL_ERROR_MESSAGE });
        expect(String(thrown)).not.toContain("do-not-echo");
        expect(JSON.stringify(thrown.cause ?? null)).not.toContain("do-not-echo");
        expect(thrown.errorBody ?? "").not.toContain("do-not-echo");
      }
    },
  );

  it("attaches privacy-safe diagnostics as cause, errorCode, and errorBody", () => {
    const truncated = '{"secret":"do-not-echo"';
    const thrown = captureError(() => parseTerminalToolCallArguments(truncated, undefined, REPAIR));
    const expected = {
      code: "malformed_tool_call_arguments",
      argumentChars: truncated.length,
      argumentHash: expect.stringMatching(/^[0-9a-z]+$/),
      repairAttempted: true,
    };
    expect(thrown.cause).toEqual(expected);
    expect(thrown.errorCode).toBe("malformed_tool_call_arguments");
    expect(JSON.parse(thrown.errorBody ?? "{}")).toEqual(expected);
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
    finalizeTerminalToolCallArguments(calls, (call) => call.partialJson, undefined, REPAIR);
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
    expect(() =>
      finalizeTerminalToolCallArguments(calls, (call) => call.partialJson, undefined, REPAIR),
    ).toThrow(MALFORMED_TOOL_CALL_TERMINAL_ERROR_MESSAGE);
    expect(calls[0]?.arguments).toEqual({});
    expect(calls[1]?.arguments).toEqual({});
  });
});
