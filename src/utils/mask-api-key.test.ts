// API key masking tests cover redaction of provider credential values.
import { describe, expect, it } from "vitest";
import { maskApiKey } from "./mask-api-key.js";

describe("maskApiKey", () => {
  it("returns missing for empty values", () => {
    expect(maskApiKey("")).toBe("missing");
    expect(maskApiKey("   ")).toBe("missing");
  });

  it("masks short and medium values without returning raw secrets", () => {
    expect(maskApiKey(" abcdefghijklmnop ")).toBe("ab...op");
    expect(maskApiKey(" short ")).toBe("s...t");
    expect(maskApiKey(" a ")).toBe("a...a");
    expect(maskApiKey(" ab ")).toBe("a...b");
  });

  it("masks long values with first and last 8 chars", () => {
    expect(maskApiKey("1234567890abcdefghijklmnop")).toBe("12345678...ijklmnop"); // pragma: allowlist secret
  });
});
