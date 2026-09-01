import { describe, expect, it } from "vitest";
import { formatStrictJsonParseFailure } from "./error-format.js";

describe("formatStrictJsonParseFailure", () => {
  it("keeps the bounded JSON preview UTF-16 well-formed", () => {
    const value = `${"x".repeat(44)}🚀tail`;

    const message = formatStrictJsonParseFailure({ value, cause: "invalid token" });

    expect(message).toContain(`${"x".repeat(44)}...`);
    expect(message).not.toContain("\uD83D");
  });

  it("suggests shell-safe quoting for structured JSON values", () => {
    const message = formatStrictJsonParseFailure({
      value: '[telegram:user-id]',
      cause: new SyntaxError("Unexpected token t in JSON at position 1"),
    });

    expect(message).toContain("If your shell stripped quotes from the JSON value");
    expect(message).toContain("in PowerShell, use single quotes around the JSON");
    expect(message).toContain(
      `openclaw config set commands.ownerAllowFrom '["telegram:user-id"]' --strict-json`,
    );
  });

  it("does not add shell quoting guidance for scalar JSON", () => {
    const message = formatStrictJsonParseFailure({
      value: "not-json",
      cause: new SyntaxError("Unexpected token o in JSON at position 1"),
    });

    expect(message).not.toContain("If your shell stripped quotes");
  });
});