import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { buildForkedGatewaySessionEntry } from "./session-create-fork-entry.js";

describe("buildForkedGatewaySessionEntry", () => {
  it("preserves adopted node ancestry and links the replaced generation", () => {
    const previous: SessionEntry = {
      sessionId: "adopted-generation",
      updatedAt: 1,
      forkSource: { sessionKey: "agent:main:original", sessionId: "original-generation" },
    };

    const forked = buildForkedGatewaySessionEntry(
      previous,
      { sessionId: "next-generation", sessionFile: "/tmp/next-generation.jsonl" },
      { sessionKey: "agent:main:new-parent", sessionId: "new-parent-generation" },
      previous,
    );

    expect(forked).toMatchObject({
      sessionId: "next-generation",
      previousSessionId: "adopted-generation",
      forkSource: { sessionKey: "agent:main:original", sessionId: "original-generation" },
    });
  });

  it("uses the requested ancestry for a genuinely new node", () => {
    const entry: SessionEntry = { sessionId: "provisional", updatedAt: 1 };
    const forked = buildForkedGatewaySessionEntry(
      entry,
      { sessionId: "forked", sessionFile: "/tmp/forked.jsonl" },
      { sessionKey: "agent:main:parent", sessionId: "parent-generation" },
    );

    expect(forked.forkSource).toEqual({
      sessionKey: "agent:main:parent",
      sessionId: "parent-generation",
    });
    expect(forked.previousSessionId).toBeUndefined();
  });
});
