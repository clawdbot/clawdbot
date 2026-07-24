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
  it("rejects a legacy successor file that cannot map to SQLite", () => {
    const state = promptState();

    expect(() =>
      applyEmbeddedAttemptSessionIdentity({
        sessionPromptState: state,
        sessionIdUsed: "session-after",
        sessionFileUsed: "/tmp/session-after.jsonl",
      }),
    ).toThrow("successor files are unsupported");
  });

  it("resolves a legacy SQLite marker successor", () => {
    const state = promptState();

    applyEmbeddedAttemptSessionIdentity({
      sessionPromptState: state,
      sessionIdUsed: "session-after",
      sessionFileUsed: "sqlite:main:session-after:/tmp/sessions.json",
    });

    expect(state.sessionTarget).toMatchObject({
      agentId: "main",
      sessionId: "session-after",
      sessionKey: "agent:main:main",
      storePath: "/tmp/sessions.json",
    });
  });

  it.each(["sqlite:other:session-after:/tmp/sessions.json", "agent:other:main"])(
    "rejects a cross-agent legacy successor identity: %s",
    (sessionFileUsed) => {
      const state = promptState();

      expect(() =>
        applyEmbeddedAttemptSessionIdentity({
          sessionPromptState: state,
          sessionIdUsed: "session-after",
          sessionFileUsed,
        }),
      ).toThrow(/successor (identity is inconsistent|files are unsupported)/u);
    },
  );

  it("retargets an id-only successor without discarding its SQLite identity", () => {
    const state = promptState();

    applyEmbeddedAttemptSessionIdentity({
      sessionPromptState: state,
      sessionIdUsed: "session-after",
    });

    expect(state.sessionTarget).toMatchObject({ sessionId: "session-after" });
  });
});
