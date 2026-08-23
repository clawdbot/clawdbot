import { describe, expect, it } from "vitest";
import { formatErrorMessage } from "./browser-error-runtime.js";

describe("browser error formatting", () => {
  it.each([
    ["request failed: Bearer browser-token-credential", "request failed: Bearer [redacted]"],
    ["provider rejected sk-browser_token_123", "provider rejected [redacted]"],
    ["upstream returned token=browser-token-credential", "upstream returned token=[redacted]"],
    ['upstream returned token="browser-token-credential"', 'upstream returned token="[redacted]"'],
    [
      '{"access_token":"browser-token-credential","status":401}',
      '{"access_token":"[redacted]","status":401}',
    ],
    [
      "request failed: https://example.test/path?x=1&access_token=browser-token-credential",
      "request failed: https://example.test/path?x=1&access_token=[redacted]",
    ],
  ])("redacts common credential forms in %s", (message, expected) => {
    expect(formatErrorMessage(new Error(message))).toBe(expected);
  });
});
