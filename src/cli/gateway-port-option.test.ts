// Gateway port option tests cover strict CLI validation before transports open.
import { describe, expect, it } from "vitest";
import { parseGatewayPortOption } from "./gateway-port-option.js";

describe("parseGatewayPortOption", () => {
  it.each([
    ["1", 1],
    ["18789", 18_789],
    [" \t18789 ", 18_789],
    [1e4, 10_000],
    [65_535, 65_535],
    [18_789n, 18_789],
  ])("accepts TCP port value %s", (value, expected) => {
    expect(parseGatewayPortOption(value)).toBe(expected);
  });

  it("treats absent values as no override", () => {
    expect(parseGatewayPortOption(undefined)).toBeUndefined();
    expect(parseGatewayPortOption(null)).toBeUndefined();
  });

  it.each(["", " \t ", "0", "65536", "1e4", "18789ms", 1.5, 65_536n])(
    "rejects invalid port value %s",
    (value) => {
      expect(() => parseGatewayPortOption(value)).toThrow(
        "--port must be an integer between 1 and 65535.",
      );
    },
  );
});
