import { describe, expect, it } from "vitest";
import { conversationSelectionKey, findConversationBySelectionKey } from "./ui-conversation-key.js";

describe("QA Lab conversation selection", () => {
  it("resolves the selected account without borrowing a same-id conversation", () => {
    const conversations = [
      { accountId: "account-a", id: "shared", kind: "channel" as const },
      { accountId: "account-b", id: "shared", kind: "channel" as const },
      { accountId: "account-a", id: "shared", kind: "direct" as const },
    ];

    expect(
      findConversationBySelectionKey(
        conversations,
        conversationSelectionKey({ accountId: "account-b", id: "shared", kind: "channel" }),
      ),
    ).toEqual({ accountId: "account-b", id: "shared", kind: "channel" });
    expect(findConversationBySelectionKey(conversations, null)).toBeUndefined();
  });
});
