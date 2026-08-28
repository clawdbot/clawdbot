import { describe, expect, it } from "vitest";
import { scrubDoctorErrorMessage } from "./doctor-error-message.js";

describe("scrubDoctorErrorMessage", () => {
  it("keeps word separation for multi-line errors", () => {
    const scrubbed = scrubDoctorErrorMessage(
      new Error("Gateway not reachable.\nStart it with `openclaw gateway run`.\r\n\tCheck status."),
    );
    expect(scrubbed).toBe(
      "Gateway not reachable. Start it with `openclaw gateway run`. Check status.",
    );
  });

  it("drops non-whitespace control characters and caps length", () => {
    const scrubbed = scrubDoctorErrorMessage(`a\u0000b\u0007c ${"x".repeat(300)}`);
    expect(scrubbed.startsWith("abc x")).toBe(true);
    expect(scrubbed.endsWith("...")).toBe(true);
    expect(scrubbed.length).toBeLessThanOrEqual(256);
  });
});
