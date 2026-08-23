import { describe, expect, it } from "vitest";
import { isCronInvalidRequestError } from "./cron-error-classification.js";

describe("isCronInvalidRequestError", () => {
  it.each([
    "cron script payload has a syntax error: Unexpected token (line 1, column 10)",
    "cron trigger script has a syntax error: Unexpected token (line 1, column 10)",
    "cron script payload must not be empty",
    "cron script payloads cannot be combined with a condition trigger",
    "cron script payloads are disabled because the operator set cron.triggers.enabled: false; remove it or set it to true to allow unattended scripts",
  ])("classifies script payload validation: %s", (message) => {
    expect(isCronInvalidRequestError(new Error(message))).toBe(true);
  });

  it.each(["cron script payload runtime failed", "cron trigger runtime failed"])(
    "does not classify unrelated script runtime failures: %s",
    (message) => {
      expect(isCronInvalidRequestError(new Error(message))).toBe(false);
    },
  );

  it("classifies ambiguous announce delivery validation", () => {
    expect(
      isCronInvalidRequestError(
        new Error(
          "cron announce delivery requires an explicit channel when multiple channels are configured (discord, reef)",
        ),
      ),
    ).toBe(true);
  });
});
