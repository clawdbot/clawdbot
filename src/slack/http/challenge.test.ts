import { describe, expect, it } from "vitest";

import { handleUrlVerification, isUrlVerification } from "./challenge.js";

describe("isUrlVerification", () => {
  it("returns true for a valid challenge event", () => {
    const payload = {
      type: "url_verification",
      challenge: "challenge-token",
      token: "verification-token",
    };

    expect(isUrlVerification(payload)).toBe(true);
  });

  it("returns false for a regular event payload", () => {
    const payload = {
      type: "event_callback",
      event: { type: "app_mention" },
    };

    expect(isUrlVerification(payload)).toBe(false);
  });
});

describe("handleUrlVerification", () => {
  it("returns the challenge string", () => {
    const payload = {
      type: "url_verification",
      challenge: "challenge-token",
      token: "verification-token",
    };

    expect(handleUrlVerification(payload)).toBe("challenge-token");
  });
});
