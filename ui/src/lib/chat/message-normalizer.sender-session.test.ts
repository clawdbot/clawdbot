// @vitest-environment node
import { describe, it, expect } from "vitest";
import { normalizeMessage } from "./message-normalizer.ts";

describe("message-normalizer senderSession", () => {
  it.each([
    { sessionKey: "agent:main:main", agentId: "main" },
    { sessionKey: "agent:main:main" },
    { agentId: "main" },
  ])("preserves forwarded source-session attribution %o", (senderSession) => {
    expect(
      normalizeMessage({ role: "assistant", content: "Forwarded report", senderSession }),
    ).toMatchObject({ senderSession });
  });

  it.each([
    { senderSession: undefined },
    { senderSession: null },
    { senderSession: "agent:main:main" },
    { senderSession: [] },
    { senderSession: {} },
    { senderSession: { sessionKey: "  ", agentId: "\t" } },
    { senderSession: { sessionKey: 42, agentId: false } },
  ])(
    "ignores absent or malformed source-session attribution $senderSession without losing text",
    ({ senderSession }) => {
      const normalized = normalizeMessage({
        role: "assistant",
        content: "Forwarded report",
        senderSession,
      });
      expect(normalized.senderSession).toBeUndefined();
      expect(normalized.content).toEqual([{ type: "text", text: "Forwarded report" }]);
    },
  );

  it("keeps a valid source agent when its source-session key is malformed", () => {
    expect(
      normalizeMessage({
        role: "assistant",
        content: "Forwarded report",
        senderSession: { sessionKey: 42, agentId: "main" },
      }).senderSession,
    ).toEqual({ agentId: "main" });
  });
});
