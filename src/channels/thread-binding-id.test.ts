// Thread binding id tests cover stable identifiers for channel thread bindings.
import { describe, expect, it } from "vitest";
import { resolveThreadBindingConversationIdFromBindingId } from "./thread-binding-id.js";

describe("resolveThreadBindingConversationIdFromBindingId", () => {
  it("returns the conversation id for matching account-prefixed binding ids", () => {
    expect(
      resolveThreadBindingConversationIdFromBindingId({
        accountId: "default",
        bindingId: "default:thread-123",
      }),
    ).toBe("thread-123");
  });

  it("returns undefined when binding id is missing or account prefix does not match", () => {
    expect(
      resolveThreadBindingConversationIdFromBindingId({
        accountId: "default",
        bindingId: undefined,
      }),
    ).toBeUndefined();
    expect(
      resolveThreadBindingConversationIdFromBindingId({
        accountId: "default",
        bindingId: "work:thread-123",
      }),
    ).toBeUndefined();
  });

  it("trims whitespace and rejects empty ids after the account prefix", () => {
    expect(
      resolveThreadBindingConversationIdFromBindingId({
        accountId: "default",
        bindingId: "  default:group-1:topic:99  ",
      }),
    ).toBe("group-1:topic:99");
    expect(
      resolveThreadBindingConversationIdFromBindingId({
        accountId: "default",
        bindingId: "default:   ",
      }),
    ).toBeUndefined();
  });
});
