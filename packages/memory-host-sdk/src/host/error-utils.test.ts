// Memory Host SDK tests cover error formatting and secret redaction.
import { describe, expect, it } from "vitest";
import { formatErrorMessage } from "./error-utils.js";

const TOKEN_CASES = [
  ["leading surrogate boundary", "abcde😀xxxxxxxxwxyz"],
  ["trailing surrogate boundary", "abcdefghijklm😀xyz"],
  ["intact leading pair", "abcd😀xxxxxxxxwxyz"],
  ["intact trailing pair", "abcdefghijklmn😀xy"],
] as const;

describe("formatErrorMessage", () => {
  it.each(TOKEN_CASES)("fully masks token assignments at a %s", (_label, token) => {
    const output = formatErrorMessage(`TOKEN=${token}`);
    expect(output).toBe("TOKEN=***");
    expect(output).not.toContain(token);
  });

  it("redacts repeated key text and replacement metacharacters in values", () => {
    const repeatedSecret = "prefix-LONG_LONG_LONG_TOKEN-suffix";
    const repeatedOutput = formatErrorMessage(`LONG_LONG_LONG_TOKEN=${repeatedSecret}`);
    expect(repeatedOutput).toBe("LONG_LONG_LONG_TOKEN=prefix…ffix");
    expect(repeatedOutput).not.toContain(repeatedSecret);

    const replacementSecret = "$&abcdxxxxxxxxwxyz";
    const replacementOutput = formatErrorMessage(`TOKEN=${replacementSecret}`);
    expect(replacementOutput).toBe("TOKEN=***&abcd…wxyz");
    expect(replacementOutput).not.toContain(replacementSecret);
  });

  it("redacts bearer schemes case-insensitively", () => {
    const secret = "memory/Start~opaque-memoryEnd";
    const output = formatErrorMessage(`bearer ${secret}`);
    expect(output).toBe("bearer memory…yEnd");
    expect(output).not.toContain(secret);
  });

  it("redacts quoted short bearer header values", () => {
    const secret = "t7K4_x";
    const output = formatErrorMessage(`{"Authorization":"bearer ${secret}"}`);
    expect(output).toBe('{"Authorization":"***"}');
    expect(output).not.toContain(secret);
  });

  it("redacts payment card and CVV assignments", () => {
    const pan = "4242424242424242";
    const cvv = "123";
    const output = formatErrorMessage(new Error(`payment declined: card_number=${pan} cvv=${cvv}`));

    expect(output).not.toContain(pan);
    expect(output).not.toContain(`cvv=${cvv}`);
    expect(output).not.toContain(cvv);
    expect(output).not.toContain("4242424242");
  });

  it("redacts JSON-shaped payment card fields", () => {
    const pan = "4242424242424242";
    const output = formatErrorMessage(`{"cardNumber":"${pan}"}`);

    expect(output).not.toContain(pan);
    expect(output).not.toContain("4242424242");
  });
});
