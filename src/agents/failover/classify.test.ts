import { describe, expect, it } from "vitest";
import { classifyFailoverReason } from "./classify.js";

describe("Claude CLI logged-out failures", () => {
  const loggedOutMessage = "Not logged in · Please run /login";

  it("classifies the logged-out response as auth only for claude-cli", () => {
    expect(classifyFailoverReason(loggedOutMessage, { provider: "claude-cli" })).toBe("auth");
    expect(classifyFailoverReason(loggedOutMessage, { provider: "openai" })).toBeNull();
    expect(classifyFailoverReason(loggedOutMessage)).toBeNull();
  });
});

describe("OAuth session expiry", () => {
  const expiredMessage = "Failed to authenticate: OAuth session expired and could not be refreshed";

  it("classifies OAuth expiry as auth only for claude-cli", () => {
    expect(classifyFailoverReason(expiredMessage, { provider: "claude-cli" })).toBe("auth");
    expect(classifyFailoverReason(expiredMessage, { provider: "custom-cli" })).toBe(
      "session_expired",
    );
    expect(classifyFailoverReason(expiredMessage)).toBe("session_expired");
  });
});
