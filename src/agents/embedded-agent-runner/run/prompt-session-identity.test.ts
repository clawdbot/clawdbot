import { describe, expect, it } from "vitest";
import { resolvePromptSessionIdentity } from "./prompt-session-identity.js";

describe("resolvePromptSessionIdentity", () => {
  it("renders the run's own session identity by default", () => {
    expect(
      resolvePromptSessionIdentity({ sessionId: "run-session", sessionKey: "agent:main:main" }),
    ).toEqual({ sessionId: "run-session", sessionKey: "agent:main:main" });
  });

  it("mirrors the foreground identity a detached helper run replays", () => {
    expect(
      resolvePromptSessionIdentity({
        sessionId: "internal-session-effects-skill-workshop-review_1",
        sessionKey: "agent:main:internal-session-effects:skill-workshop-review_1",
        promptSessionIdentity: { sessionId: "foreground-session", sessionKey: "agent:main:main" },
      }),
    ).toEqual({ sessionId: "foreground-session", sessionKey: "agent:main:main" });
  });

  it("ignores blank override fields and omits a missing session key", () => {
    expect(
      resolvePromptSessionIdentity({
        sessionId: "run-session",
        promptSessionIdentity: { sessionId: " ", sessionKey: "" },
      }),
    ).toEqual({ sessionId: "run-session" });
  });
});
