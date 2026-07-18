// Imessage test support covers conversation repair plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { repairIMessageConversationAnchor } from "./conversation-repair.js";
import type { IMessagePayload } from "./types.js";

function anchorlessMessage(overrides: Partial<IMessagePayload> = {}): IMessagePayload {
  return {
    id: 9500,
    guid: "ANCHORLESS-GUID-1",
    chat_id: 0,
    sender: "+15550000001",
    destination_caller_id: "+15550000001",
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

describe("repairIMessageConversationAnchor", () => {
  it.each([
    anchorlessMessage({ chat_id: 349, is_group: true }),
    anchorlessMessage({ chat_guid: "iMessage;+;chat349", is_group: true }),
    anchorlessMessage({ chat_identifier: "chat349", is_group: true }),
    {
      guid: "DM-GUID",
      sender: "+15550001111",
      is_from_me: false,
      text: "hello",
    } satisfies IMessagePayload,
  ])("passes through anchored and sender-only messages without recovery RPCs", async (message) => {
    const client = mockClient([]);

    await expect(
      repairIMessageConversationAnchor({ client: client as never, message }),
    ).resolves.toBe(message);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("recovers the full authoritative projection from recent history by GUID", async () => {
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
            sender: "+15550002222",
            destination_caller_id: "+15550001111",
            is_from_me: false,
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
      sender: "+15550002222",
      destination_caller_id: "+15550001111",
      is_from_me: false,
      is_group: true,
    });
  });

  it("replaces a stale local sender with the remote sender from exact-GUID history", async () => {
    const message = anchorlessMessage({
      guid: "11111111-1111-4111-8111-111111111111",
      sender: "+15550000001",
      destination_caller_id: "+15550000001",
    });
    const client = mockClient([
      {
        id: 42,
        messages: [
          {
            guid: "11111111-1111-4111-8111-111111111111",
            chat_id: 42,
            chat_guid: "iMessage;-;+15550000002",
            chat_identifier: "+15550000002",
            sender: "+15550000002",
            destination_caller_id: "+15550000001",
            is_from_me: false,
            is_group: false,
          },
        ],
      },
    ]);

    const repaired = await repairIMessageConversationAnchor({
      client: client as never,
      message,
    });

    expect(repaired).toMatchObject({
      chat_id: 42,
      chat_guid: "iMessage;-;+15550000002",
      chat_identifier: "+15550000002",
      sender: "+15550000002",
      destination_caller_id: "+15550000001",
      is_from_me: false,
      is_group: false,
    });
  });

  it("recovers anchorless history when destination_caller_id is omitted", async () => {
    const message = anchorlessMessage({
      guid: "22222222-2222-4222-8222-222222222222",
      sender: "+15550000001",
      destination_caller_id: "+15550000001",
    });
    const client = mockClient([
      {
        id: 42,
        messages: [
          {
            guid: "22222222-2222-4222-8222-222222222222",
            chat_id: 42,
            chat_guid: "iMessage;-;+15550000002",
            chat_identifier: "+15550000002",
            sender: "+15550000002",
            is_from_me: false,
            is_group: false,
          },
        ],
      },
    ]);

    const repaired = await repairIMessageConversationAnchor({
      client: client as never,
      message,
    });

    expect(repaired).toMatchObject({
      chat_id: 42,
      chat_guid: "iMessage;-;+15550000002",
      chat_identifier: "+15550000002",
      sender: "+15550000002",
      is_from_me: false,
      is_group: false,
    });
    expect(repaired?.destination_caller_id ?? null).toBeNull();
  });

  it("routes repaired direct replies to the remote peer instead of the stale local sender", async () => {
    const { buildIMessageInboundContext, resolveIMessageInboundDecision } =
      await import("./inbound-processing.js");
    const message = anchorlessMessage({
      guid: "11111111-1111-4111-8111-111111111111",
      sender: "+15550000001",
      destination_caller_id: "+15550000001",
    });
    const client = mockClient([
      {
        id: 42,
        messages: [
          {
            guid: "11111111-1111-4111-8111-111111111111",
            chat_id: 42,
            chat_guid: "iMessage;-;+15550000002",
            chat_identifier: "+15550000002",
            sender: "+15550000002",
            destination_caller_id: "+15550000001",
            is_from_me: false,
            is_group: false,
          },
        ],
      },
    ]);

    const repaired = await repairIMessageConversationAnchor({
      client: client as never,
      message,
    });
    expect(repaired?.sender).toBe("+15550000002");

    const decision = await resolveIMessageInboundDecision({
      cfg: {} as never,
      accountId: "default",
      message: repaired!,
      messageText: repaired!.text ?? "",
      bodyText: repaired!.text ?? "",
      allowFrom: ["*"],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
    });
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }

    const { imessageTo, ctxPayload } = await buildIMessageInboundContext({
      cfg: {} as never,
      decision,
      message: repaired!,
      historyLimit: 0,
      groupHistories: new Map(),
    });

    expect(imessageTo).toBe("imessage:+15550000002");
    expect(ctxPayload.To).toBe("imessage:+15550000002");
    expect(ctxPayload.To).not.toBe("imessage:+15550000001");
  });

  it("clears stale destination_caller_id on the monitor path when history omits it", async () => {
    const { buildIMessageInboundContext, resolveIMessageInboundDecision } =
      await import("./inbound-processing.js");
    const message = anchorlessMessage({
      guid: "33333333-3333-4333-8333-333333333333",
      sender: "+15550000001",
      destination_caller_id: "+15550000001",
    });
    const client = mockClient([
      {
        id: 42,
        messages: [
          {
            guid: "33333333-3333-4333-8333-333333333333",
            chat_id: 42,
            chat_guid: "iMessage;-;+15550000002",
            chat_identifier: "+15550000002",
            sender: "+15550000002",
            is_from_me: false,
            is_group: false,
          },
        ],
      },
    ]);

    const repaired = await repairIMessageConversationAnchor({
      client: client as never,
      message,
    });
    expect(repaired?.sender).toBe("+15550000002");
    expect(repaired?.destination_caller_id ?? null).toBeNull();

    const decision = await resolveIMessageInboundDecision({
      cfg: {} as never,
      accountId: "default",
      message: repaired!,
      messageText: repaired!.text ?? "",
      bodyText: repaired!.text ?? "",
      allowFrom: ["*"],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
    });
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }

    const { imessageTo, ctxPayload } = await buildIMessageInboundContext({
      cfg: {} as never,
      decision,
      message: repaired!,
      historyLimit: 0,
      groupHistories: new Map(),
    });

    expect(imessageTo).toBe("imessage:+15550000002");
    expect(ctxPayload.To).toBe("imessage:+15550000002");
  });

  it("drops fail-closed when authoritative history says is_from_me=true", async () => {
    const runtime = { error: vi.fn() };
    const client = mockClient([
      {
        id: 42,
        messages: [
          {
            guid: "ANCHORLESS-GUID-1",
            chat_id: 42,
            chat_guid: "iMessage;-;+15550000002",
            chat_identifier: "+15550000002",
            sender: "+15550000002",
            destination_caller_id: "+15550000001",
            is_from_me: true,
            is_group: false,
          },
        ],
      },
    ]);

    await expect(
      repairIMessageConversationAnchor({
        client: client as never,
        message: anchorlessMessage({ is_from_me: false }),
        runtime,
      }),
    ).resolves.toBeNull();
    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain(
      "recovered authoritative row is from-me",
    );
  });

  it("drops fail-closed when exact-GUID history projections conflict", async () => {
    const runtime = { error: vi.fn() };
    const client = mockClient([
      {
        id: 100,
        messages: [
          {
            guid: "ANCHORLESS-GUID-1",
            chat_id: 100,
            chat_guid: "iMessage;-;+15550000002",
            chat_identifier: "+15550000002",
            sender: "+15550000002",
            destination_caller_id: "+15550000001",
            is_from_me: false,
            is_group: false,
          },
        ],
      },
      {
        id: 200,
        messages: [
          {
            guid: "ANCHORLESS-GUID-1",
            chat_id: 200,
            chat_guid: "iMessage;-;+15550000003",
            chat_identifier: "+15550000003",
            sender: "+15550000003",
            destination_caller_id: "+15550000001",
            is_from_me: false,
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
    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain(
      "conflicting exact-GUID history projections",
    );
  });

  it("keeps recovered group destination while using authoritative sender and direction", async () => {
    const message = anchorlessMessage({
      sender: "+15550000001",
      destination_caller_id: "+15550000001",
      is_group: false,
    });
    const client = mockClient([
      {
        id: 900,
        messages: [
          {
            guid: "ANCHORLESS-GUID-1",
            chat_id: 900,
            chat_guid: "iMessage;+;group900",
            chat_identifier: "group900",
            chat_name: "Ops",
            participants: ["+15550000001", "+15550000002", "+15550000003"],
            sender: "+15550000002",
            destination_caller_id: "+15550000001",
            is_from_me: false,
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
      chat_id: 900,
      chat_guid: "iMessage;+;group900",
      chat_identifier: "group900",
      chat_name: "Ops",
      participants: ["+15550000001", "+15550000002", "+15550000003"],
      sender: "+15550000002",
      destination_caller_id: "+15550000001",
      is_from_me: false,
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
            sender: "+15550000002",
            destination_caller_id: "+15550000001",
            is_from_me: false,
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
    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain("exact-GUID history row is incomplete");
  });
});
