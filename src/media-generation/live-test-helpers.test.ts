import { describe, expect, it } from "vitest";
import { redactLiveApiKey } from "./live-test-helpers.js";

describe("media-generation live-test helpers", () => {
  it("redacts live API keys for diagnostics", () => {
    expect(redactLiveApiKey(undefined)).toBe("none");
    expect(redactLiveApiKey("   ")).toBe("none");
    expect(redactLiveApiKey("synthetic-12")).toBe("<redacted>");
    expect(redactLiveApiKey("synthetic-credential-value")).toBe("<redacted>");
  });
});
