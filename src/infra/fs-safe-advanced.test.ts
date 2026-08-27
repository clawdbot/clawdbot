import { describe, expect, it } from "vitest";
import { sanitizeUntrustedFileName } from "./fs-safe-advanced.js";

// Guards the fs-safe 0.5.2 adoption: the package now owns untrusted filename
// sanitization, including Windows reserved-name suffixing the old local copy lacked.
describe("sanitizeUntrustedFileName", () => {
  it("suffixes Windows reserved basenames while preserving case and extension", () => {
    expect(sanitizeUntrustedFileName("CON", "fallback")).toBe("CON_");
    expect(sanitizeUntrustedFileName("nul.txt", "fallback")).toBe("nul_.txt");
    expect(sanitizeUntrustedFileName("aux.c", "fallback")).toBe("aux_.c");
  });

  it("strips path segments and Windows-invalid characters", () => {
    expect(sanitizeUntrustedFileName("../evil/re<po|rt?.pdf", "fallback")).toBe("report.pdf");
  });

  it("falls back when nothing usable remains", () => {
    expect(sanitizeUntrustedFileName("  ..  ", "fallback")).toBe("fallback");
  });
});
