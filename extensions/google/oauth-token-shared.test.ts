// Google tests cover oauth token shared plugin behavior.
import { describe, expect, it } from "vitest";
import { formatGoogleOauthApiKey, parseGoogleOauthApiKey } from "./oauth-token-shared.js";

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

  it("parses structured oauth payload fields", () => {
    expect(
      parseGoogleOauthApiKey(JSON.stringify({ token: "usage-token", projectId: "proj-1" })),
    ).toEqual({
      token: "usage-token",
      projectId: "proj-1",
    });
  });
});
