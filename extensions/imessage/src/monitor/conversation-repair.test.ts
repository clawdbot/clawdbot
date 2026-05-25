import { describe, expect, it, vi } from "vitest";
import { isIMessageAnchorless, repairIMessageConversationAnchor } from "./conversation-repair.js";
import type { IMessagePayload } from "./types.js";

function anchorlessMessage(overrides: Partial<IMessagePayload> = {}): IMessagePayload {
  return {
    id: 9500,
    guid: "ANCHORLESS-GUID-1",
    chat_id: 0,
    sender: "+15550001111",
    is_from_me: false,
    text: "https://example.com",
    chat_guid: "",
    chat_identifier: "",
    chat_name: "",
    participants: null,
    is_group: false,
    ...overrides,
  };
}

function mockClient(chats: Array<{ id: number; messages: Record<string, unknown>[] }>) {
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "chats.list") {
      return { chats: chats.map((chat) => ({ id: chat.id })) };
    }
    if (method === "messages.history") {
      return {
        messages: chats.find((chat) => chat.id === params?.chat_id)?.messages ?? [],
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  return { request };
}

describe("isIMessageAnchorless", () => {
  it("detects explicit broken conversation anchors", () => {
    expect(isIMessageAnchorless(anchorlessMessage())).toBe(true);
    expect(isIMessageAnchorless(anchorlessMessage({ chat_guid: undefined }))).toBe(true);
    expect(isIMessageAnchorless(anchorlessMessage({ chat_identifier: undefined }))).toBe(true);
    expect(
      isIMessageAnchorless(
        anchorlessMessage({ chat_id: undefined, chat_guid: "", chat_identifier: "" }),
      ),
    ).toBe(true);
  });

  it("does not classify sender-only direct messages as anchorless", () => {
    expect(
      isIMessageAnchorless({
        guid: "DM-GUID",
        sender: "+15550001111",
        is_from_me: false,
        text: "hello",
      }),
    ).toBe(false);
  });

  it("does not classify messages with any usable conversation anchor", () => {
    expect(isIMessageAnchorless(anchorlessMessage({ chat_id: 349 }))).toBe(false);
    expect(isIMessageAnchorless(anchorlessMessage({ chat_guid: "iMessage;+;chat349" }))).toBe(
      false,
    );
    expect(isIMessageAnchorless(anchorlessMessage({ chat_identifier: "chat349" }))).toBe(false);
  });
});

describe("repairIMessageConversationAnchor", () => {
  it("passes through non-anchorless messages without recovery RPCs", async () => {
    const message = anchorlessMessage({ chat_id: 349, is_group: true });
    const client = mockClient([]);

    await expect(
      repairIMessageConversationAnchor({ client: client as never, message }),
    ).resolves.toBe(message);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("recovers the conversation from recent history by GUID", async () => {
    const message = anchorlessMessage();
    const client = mockClient([
      { id: 100, messages: [{ guid: "OTHER-GUID", chat_id: 100, is_group: true }] },
      {
        id: 349,
        messages: [
          {
            guid: "ANCHORLESS-GUID-1",
            chat_id: 349,
            chat_guid: "iMessage;+;chat349",
            chat_identifier: "chat349",
            chat_name: "Project group",
            participants: ["+15550001111", "+15550002222"],
            is_group: true,
          },
        ],
      },
    ]);

    const repaired = await repairIMessageConversationAnchor({
      client: client as never,
      message,
    });

    expect(repaired).toMatchObject({
      chat_id: 349,
      chat_guid: "iMessage;+;chat349",
      chat_identifier: "chat349",
      chat_name: "Project group",
      participants: ["+15550001111", "+15550002222"],
      is_group: true,
    });
  });

  it("drops fail-closed when the GUID cannot be matched", async () => {
    const runtime = { error: vi.fn() };
    const client = mockClient([{ id: 349, messages: [{ guid: "OTHER-GUID", chat_id: 349 }] }]);

    await expect(
      repairIMessageConversationAnchor({
        client: client as never,
        message: anchorlessMessage(),
        runtime,
      }),
    ).resolves.toBeNull();
    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain("no recent chat matched");
  });

  it("drops fail-closed when history finds the GUID but no usable anchor", async () => {
    const runtime = { error: vi.fn() };
    const client = mockClient([
      {
        id: 349,
        messages: [
          {
            guid: "ANCHORLESS-GUID-1",
            chat_id: 0,
            chat_guid: "",
            chat_identifier: "",
            is_group: false,
          },
        ],
      },
    ]);

    await expect(
      repairIMessageConversationAnchor({
        client: client as never,
        message: anchorlessMessage(),
        runtime,
      }),
    ).resolves.toBeNull();
    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain("no usable conversation anchor");
  });
});
