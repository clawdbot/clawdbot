// Normalization Core tests cover boolean coerce behavior.
import { parseBoolean } from "@openclaw/normalization-core/boolean-coercion";
import { describe, expect, it } from "vitest";

describe("normalization-core/boolean-coercion", () => {
  it.each([
    [true, true],
    [false, false],
    ["true", true],
    [" FALSE ", false],
    ["TrUe", true],
  ])("parses %j as %s", (value, expected) => {
    expect(parseBoolean(value)).toBe(expected);
  });

  it.each([undefined, null, 0, 1, "", "yes", "no", "on", "off", "1", "0"])(
    "rejects unsupported value %j",
    (value) => {
      expect(parseBoolean(value)).toBeUndefined();
    },
  );
});
