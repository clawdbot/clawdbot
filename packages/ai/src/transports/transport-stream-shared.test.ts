import { describe, expect, it } from "vitest";
import {
  coerceTransportToolCallArguments,
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

describe("coerceTransportToolCallArguments", () => {
  it("preserves unsafe integer literals in recovered serialized arguments", () => {
    // Raw JSON.parse rounds integer literals above Number.MAX_SAFE_INTEGER
    // (e.g. 64-bit snowflake IDs) before provider replay; the recovered
    // arguments must match the terminal parser's string-preservation contract.
    expect(coerceTransportToolCallArguments('{"id":9223372036854775807,"safe":42}')).toEqual({
      id: "9223372036854775807",
      safe: 42,
    });
  });

  it.each(["not-an-object", '{"path":"README.md"', "[]", "null", "", 42, null, ["a"]])(
    "falls back to an empty document for non-object input %#",
    (value) => {
      expect(coerceTransportToolCallArguments(value)).toEqual({});
    },
  );
});
