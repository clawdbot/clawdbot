import { describe, expect, it } from "vitest";
import {
  defaultTopLevelPlacement,
  resolveMatrixInboundConversation,
} from "./thread-binding-api.js";

describe("Matrix thread binding public API", () => {
  it("advertises child placement for top-level Matrix rooms", () => {
    expect(defaultTopLevelPlacement).toBe("child");
  });

  it("resolves top-level room targets as parent conversations", () => {
    expect(resolveMatrixInboundConversation({ to: "channel:!room:example" })).toEqual({
      conversationId: "!room:example",
    });
  });

  it("preserves canonical room casing when resolving thread conversations", () => {
    expect(
      resolveMatrixInboundConversation({
        to: "room:!Room:Example.org",
        threadId: "$thread-root",
      }),
    ).toEqual({
      conversationId: "$thread-root",
      parentConversationId: "!Room:Example.org",
    });
  });

  it("does not resolve user targets as thread binding rooms", () => {
    expect(resolveMatrixInboundConversation({ to: "user:@user:example.org" })).toBeNull();
  });
});
