import { describe, expect, it } from "vitest";
import { parseTerminalToolCallArguments } from "./transport-stream-shared.js";

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
    },
  );
});
