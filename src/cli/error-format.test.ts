import { describe, expect, it } from "vitest";
import { formatStrictJsonParseFailure } from "./error-format.js";

describe("formatStrictJsonParseFailure", () => {
  it.each(["[telegram:123456]", "{bad", "not-json"])(
    "offers file-based recovery for invalid JSON %j",
    (value) => {
      const message = formatStrictJsonParseFailure({ value, cause: "invalid token" });

      expect(message).toContain("openclaw config patch --file <path> --dry-run");
      expect(message).toContain("JSON5 config patch object");
      expect(message).toContain("For plain strings, omit --strict-json.");
    },
  );
  it("keeps the bounded JSON preview UTF-16 well-formed", () => {
    const value = `${"x".repeat(44)}🚀tail`;

    const message = formatStrictJsonParseFailure({ value, cause: "invalid token" });

    expect(message).toContain(`${"x".repeat(44)}...`);
    expect(message).not.toContain("\uD83D");
  });
});
