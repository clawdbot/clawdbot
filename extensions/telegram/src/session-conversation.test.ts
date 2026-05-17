import { describe, expect, it } from "vitest";
import {
  resolveTelegramSessionConversation,
  resolveTelegramSessionTarget,
} from "./session-conversation.js";

describe("resolveTelegramSessionConversation", () => {
  it("owns topic session parsing and parent fallback candidates", () => {
    expect(
      resolveTelegramSessionConversation({
        kind: "group",
        rawId: "-1001:topic:77",
      }),
    ).toEqual({
      id: "-1001",
      threadId: "77",
      baseConversationId: "-1001",
      parentConversationCandidates: ["-1001"],
    });
    expect(
      resolveTelegramSessionConversation({
        kind: "group",
        rawId: "-1001:Topic:77",
      }),
    ).toEqual({
      id: "-1001",
      threadId: "77",
      baseConversationId: "-1001",
      parentConversationCandidates: ["-1001"],
    });
    expect(
      resolveTelegramSessionConversation({
        kind: "group",
        rawId: "-1001",
      }),
    ).toBeNull();
  });
});

describe("resolveTelegramSessionTarget", () => {
  it("normalizes group session ids to numeric chat ids", () => {
    expect(resolveTelegramSessionTarget({ kind: "group", id: "-1001" })).toBe("-1001");
  });

  it("normalizes channel session ids to lookup targets", () => {
    expect(resolveTelegramSessionTarget({ kind: "channel", id: "@OpenClawTeam" })).toBe(
      "@OpenClawTeam",
    );
  });
});
