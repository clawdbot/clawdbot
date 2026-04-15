import { describe, expect, it } from "vitest";
import { translateMSTeamsDmConversationIdForGraph } from "../inbound.js";

describe("translateMSTeamsDmConversationIdForGraph", () => {
  it("translates a: conversation ID to Graph format for DMs", () => {
    const result = translateMSTeamsDmConversationIdForGraph({
      isDirectMessage: true,
      conversationId: "a:1abc2def3",
      aadObjectId: "user-aad-id",
      appId: "bot-app-id",
    });
    expect(result).toBe("19:user-aad-id_bot-app-id@unq.gbl.spaces");
  });

  it("passes through non-a: conversation IDs unchanged", () => {
    const result = translateMSTeamsDmConversationIdForGraph({
      isDirectMessage: true,
      conversationId: "19:existing@unq.gbl.spaces",
      aadObjectId: "user-aad-id",
      appId: "bot-app-id",
    });
    expect(result).toBe("19:existing@unq.gbl.spaces");
  });

  it("passes through when aadObjectId is missing", () => {
    const result = translateMSTeamsDmConversationIdForGraph({
      isDirectMessage: true,
      conversationId: "a:1abc2def3",
      aadObjectId: null,
      appId: "bot-app-id",
    });
    expect(result).toBe("a:1abc2def3");
  });

  it("passes through when appId is missing", () => {
    const result = translateMSTeamsDmConversationIdForGraph({
      isDirectMessage: true,
      conversationId: "a:1abc2def3",
      aadObjectId: "user-aad-id",
      appId: null,
    });
    expect(result).toBe("a:1abc2def3");
  });

  it("passes through for non-DM conversations even with a: prefix", () => {
    const result = translateMSTeamsDmConversationIdForGraph({
      isDirectMessage: false,
      conversationId: "a:1abc2def3",
      aadObjectId: "user-aad-id",
      appId: "bot-app-id",
    });
    expect(result).toBe("a:1abc2def3");
  });
});
