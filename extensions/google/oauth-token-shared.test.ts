import { describe, expect, it } from "vitest";
import {
  formatGoogleOauthApiKey,
  parseGoogleOauthApiKey,
  parseGoogleUsageToken,
} from "./oauth-token-shared.js";

describe("google oauth token helpers", () => {
  it("formats oauth credentials with project-aware payloads", () => {
    expect(
      formatGoogleOauthApiKey({
        type: "oauth",
        access: "token-123",
        projectId: "project-abc",
      }),
    ).toBe(JSON.stringify({ token: "token-123", projectId: "project-abc" }));
  });

  it("returns an empty string for non-oauth credentials", () => {
    expect(formatGoogleOauthApiKey({ type: "token", access: "token-123" })).toBe("");
  });

  it("parses project-aware oauth payloads for usage auth", () => {
    expect(parseGoogleUsageToken(JSON.stringify({ token: "usage-token" }))).toBe("usage-token");
  });

  it("parses structured oauth payload fields", () => {
    expect(
      parseGoogleOauthApiKey(JSON.stringify({ token: "usage-token", projectId: "proj-1" })),
    ).toEqual({
      token: "usage-token",
      projectId: "proj-1",
    });
  });

  it("falls back to the raw token when the payload is not JSON", () => {
    expect(parseGoogleUsageToken("raw-token")).toBe("raw-token");
  });
});
