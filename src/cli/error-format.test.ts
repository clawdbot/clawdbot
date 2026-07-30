import { describe, expect, it } from "vitest";
import { formatStrictJsonParseFailure } from "./error-format.js";

describe("formatStrictJsonParseFailure", () => {
  it("keeps the bounded JSON preview UTF-16 well-formed", () => {
    const value = `${"x".repeat(44)}🚀tail`;

    const message = formatStrictJsonParseFailure({ value, cause: "invalid token" });

    expect(message).toContain(`${"x".repeat(44)}...`);
    expect(message).not.toContain("\uD83D");
  });
});
