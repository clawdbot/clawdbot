// Browser tests cover errors plugin behavior.
import { describe, expect, it } from "vitest";
import {
  BROWSER_ERROR_REASONS,
  BrowserProfileUnavailableError,
  BrowserTabNotFoundError,
  parseBrowserErrorPayload,
  toBrowserErrorResponse,
} from "./errors.js";

describe("BrowserTabNotFoundError", () => {
  it("teaches agents that bare numbers are not stable tab targets", () => {
    const err = new BrowserTabNotFoundError({ input: "2" });

    expect(err.message).toBe(
      'tab not found: browser tab "2" not found. Numeric values are not tab targets; use a stable tab id like "t1", a label, or a raw targetId. For positional selection, use "openclaw browser tab select 2".',
    );
  });
});

describe("no-display browser errors", () => {
  const details = {
    profile: "openclaw",
    requestedHeadless: false,
    headlessSource: "profile",
    displayPresent: false,
  } as const;

  it("maps a closed reason and typed details", () => {
    expect(
      toBrowserErrorResponse(
        new BrowserProfileUnavailableError("display required", {
          metadata: {
            reason: BROWSER_ERROR_REASONS.noDisplayForHeadedProfile,
            details,
          },
        }),
      ),
    ).toEqual({
      status: 409,
      message: "display required",
      reason: BROWSER_ERROR_REASONS.noDisplayForHeadedProfile,
      details,
    });
  });

  it("accepts only valid no-display metadata from route payloads", () => {
    const payload = {
      error: "display required",
      reason: BROWSER_ERROR_REASONS.noDisplayForHeadedProfile,
      details,
    };
    expect(parseBrowserErrorPayload(payload)).toEqual({
      error: "display required",
      reason: BROWSER_ERROR_REASONS.noDisplayForHeadedProfile,
      details,
    });
    expect(
      parseBrowserErrorPayload({
        ...payload,
        details: { ...details, requestedHeadless: true, remediation: "untrusted" },
      }),
    ).toEqual({ error: "display required" });
  });
});
