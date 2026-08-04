import { describe, expect, it } from "vitest";
import { isIncognitoSessionKey } from "./session-key.js";

describe("isIncognitoSessionKey", () => {
  it.each([
    "agent:main:dashboard:incognito-1234",
    "agent:worker:subagent:incognito-5678",
    "agent:main:internal-session-effects:incognito-run-1",
  ])("recognizes %s", (sessionKey) => {
    expect(isIncognitoSessionKey(sessionKey)).toBe(true);
  });

  it.each([
    "agent:main:dashboard:1234",
    "agent:main:dashboard:not-incognito-1234",
    "agent:main:subagent:1234",
    "dashboard:incognito-1234",
    "",
  ])("rejects %s", (sessionKey) => {
    expect(isIncognitoSessionKey(sessionKey)).toBe(false);
  });
});
