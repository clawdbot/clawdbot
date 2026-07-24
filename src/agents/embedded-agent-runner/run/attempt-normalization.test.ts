import { describe, expect, it, vi } from "vitest";
import { applyEmbeddedAttemptSessionIdentity } from "./attempt-normalization.js";

function promptState() {
  return {
    sessionId: "session-before",
    sessionFile: "agent:main:main",
    sessionTarget: {
      agentId: "main",
      sessionId: "session-before",
      sessionKey: "agent:main:main",
      storePath: "/tmp/sessions.json",
    },
    adoptSessionId: vi.fn(),
  };
}

describe("applyEmbeddedAttemptSessionIdentity", () => {
  it("clears a stale structured target for a legacy successor locator", () => {
    const state = promptState();

    applyEmbeddedAttemptSessionIdentity({
      sessionPromptState: state,
      sessionIdUsed: "session-after",
      sessionFileUsed: "/tmp/session-after.jsonl",
    });

    expect(state.sessionFile).toBe("/tmp/session-after.jsonl");
    expect(state.sessionTarget).toBeUndefined();
  });

  it("retargets an id-only successor without discarding its SQLite identity", () => {
    const state = promptState();

    applyEmbeddedAttemptSessionIdentity({
      sessionPromptState: state,
      sessionIdUsed: "session-after",
    });

    expect(state.sessionTarget).toMatchObject({ sessionId: "session-after" });
  });
});
