// Imessage tests cover actions plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";

const createIMessageRpcClientMock = vi.hoisted(() => vi.fn());
const runIMessageCliJsonCommandMock = vi.hoisted(() => vi.fn());

vi.mock("./cli-output.js", () => ({
  runIMessageCliJsonCommand: runIMessageCliJsonCommandMock,
}));

vi.mock("./client.js", () => ({
  createIMessageRpcClient: createIMessageRpcClientMock,
}));

const { imessageActionsRuntime, findChatGuidForTest, normalizeDirectChatIdentifierForTest } =
  await import("./actions.runtime.js");

afterEach(() => {
  vi.restoreAllMocks();
  createIMessageRpcClientMock.mockReset();
  runIMessageCliJsonCommandMock.mockReset();
});

function mockRpcChatList(chats: Array<Record<string, unknown>>) {
  const request = vi.fn().mockResolvedValue({ chats });
  const stop = vi.fn().mockResolvedValue(undefined);
  createIMessageRpcClientMock.mockResolvedValueOnce({ request, stop });
  return { request, stop };
}

describe("imessage actions runtime", () => {
  it("passes the configured Messages db path to private API bridge commands", async () => {
    runIMessageCliJsonCommandMock.mockResolvedValue({ success: true });

    await imessageActionsRuntime.sendReaction({
      chatGuid: "iMessage;+;chat0000",
      messageId: "message-guid",
      reaction: "like",
      options: {
        cliPath: "imsg",
        dbPath: "/tmp/messages.db",
        chatGuid: "iMessage;+;chat0000",
      },
    });

    expect(runIMessageCliJsonCommandMock).toHaveBeenCalledWith({
      cliPath: "imsg",
      dbPath: "/tmp/messages.db",
      timeoutMs: undefined,
      args: [
        "tapback",
        "--chat",
        "iMessage;+;chat0000",
        "--message",
        "message-guid",
        "--kind",
        "like",
        "--part",
        "0",
      ],
    });
  });

  it("preserves canonical CLI wrapper errors", async () => {
    const wrapperError = new Error("imsg failed");
    runIMessageCliJsonCommandMock.mockRejectedValue(wrapperError);

    await expect(
      imessageActionsRuntime.sendReaction({
        chatGuid: "iMessage;+;chat0000",
        messageId: "message-guid",
        reaction: "like",
        options: {
          cliPath: "imsg",
          chatGuid: "iMessage;+;chat0000",
        },
      }),
    ).rejects.toBe(wrapperError);
  });

  it("drops cached chats.list entries when the current clock is not a valid date timestamp", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1_700_000_000_000).mockReturnValueOnce(Number.NaN);
    const firstClient = mockRpcChatList([{ id: 1, guid: "iMessage;+;first" }]);
    const secondClient = mockRpcChatList([{ id: 2, guid: "iMessage;+;second" }]);

    await expect(
      imessageActionsRuntime.resolveChatGuidForTarget({
        target: { kind: "chat_id", chatId: 1 },
        options: { cliPath: "imsg-invalid-clock" },
      }),
    ).resolves.toBe("iMessage;+;first");
    await expect(
      imessageActionsRuntime.resolveChatGuidForTarget({
        target: { kind: "chat_id", chatId: 2 },
        options: { cliPath: "imsg-invalid-clock" },
      }),
    ).resolves.toBe("iMessage;+;second");

    expect(createIMessageRpcClientMock).toHaveBeenCalledTimes(2);
    expect(firstClient.request).toHaveBeenCalledWith(
      "chats.list",
      { limit: 1000 },
      { timeoutMs: undefined },
    );
    expect(secondClient.request).toHaveBeenCalledWith(
      "chats.list",
      { limit: 1000 },
      { timeoutMs: undefined },
    );
  });

  it("does not cache chats.list when the expiry timestamp would exceed the valid date range", async () => {
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    mockRpcChatList([{ id: 1, guid: "iMessage;+;first" }]);
    mockRpcChatList([{ id: 2, guid: "iMessage;+;second" }]);

    await expect(
      imessageActionsRuntime.resolveChatGuidForTarget({
        target: { kind: "chat_id", chatId: 1 },
        options: { cliPath: "imsg-overflow-clock" },
      }),
    ).resolves.toBe("iMessage;+;first");
    await expect(
      imessageActionsRuntime.resolveChatGuidForTarget({
        target: { kind: "chat_id", chatId: 2 },
        options: { cliPath: "imsg-overflow-clock" },
      }),
    ).resolves.toBe("iMessage;+;second");

    expect(createIMessageRpcClientMock).toHaveBeenCalledTimes(2);
  });
});

describe("findChatGuid cross-format identifier resolution", () => {
  // imsg's chats.list returns DM chats as `identifier: <phone>` and
  // `guid: any;-;<phone>`. The agent's action surface synthesizes
  // `iMessage;-;<phone>` from a phone-number target. A naive string-equality
  // lookup would miss this match — this is the bug that surfaced in
  // production today: agent passes phone target → chat-guid resolver returns
  // null → react/edit/unsend throw "no registered chat" even though chats.list
  // does have the chat.
  const chatsList = [
    {
      id: 3,
      identifier: "+12069106512",
      guid: "any;-;+12069106512",
      service: "iMessage",
      is_group: false,
    },
    {
      id: 7,
      identifier: "chat0000",
      guid: "iMessage;+;chat0000",
      service: "iMessage",
      is_group: true,
    },
  ];

  it("matches a synthesized iMessage;-;<phone> target against the chats.list <phone> identifier", () => {
    const result = findChatGuidForTest(chatsList, {
      kind: "chat_identifier",
      chatIdentifier: "iMessage;-;+12069106512",
    });
    expect(result).toBe("any;-;+12069106512");
  });

  it("matches a synthesized SMS;-;<phone> target the same way", () => {
    const result = findChatGuidForTest(chatsList, {
      kind: "chat_identifier",
      chatIdentifier: "SMS;-;+12069106512",
    });
    expect(result).toBe("any;-;+12069106512");
  });

  it("matches a bare <phone> identifier exactly", () => {
    const result = findChatGuidForTest(chatsList, {
      kind: "chat_identifier",
      chatIdentifier: "+12069106512",
    });
    expect(result).toBe("any;-;+12069106512");
  });

  it("matches an any;-;<phone> guid form against the chats.list guid column", () => {
    const result = findChatGuidForTest(chatsList, {
      kind: "chat_identifier",
      chatIdentifier: "any;-;+12069106512",
    });
    expect(result).toBe("any;-;+12069106512");
  });

  it("matches a group chat by exact guid", () => {
    const result = findChatGuidForTest(chatsList, {
      kind: "chat_identifier",
      chatIdentifier: "iMessage;+;chat0000",
    });
    expect(result).toBe("iMessage;+;chat0000");
  });

  it("matches a group chat by chat_id", () => {
    const result = findChatGuidForTest(chatsList, { kind: "chat_id", chatId: 7 });
    expect(result).toBe("iMessage;+;chat0000");
  });

  it("does not coerce non-decimal chat ids from chats.list", () => {
    const result = findChatGuidForTest(
      [
        {
          id: "0x7",
          identifier: "wrong",
          guid: "iMessage;+;wrong",
        },
      ],
      { kind: "chat_id", chatId: 7 },
    );
    expect(result).toBeNull();
  });

  it("returns null for a phone number that does not exist in chats.list", () => {
    const result = findChatGuidForTest(chatsList, {
      kind: "chat_identifier",
      chatIdentifier: "iMessage;-;+19999999999",
    });
    expect(result).toBeNull();
  });

  it("does not cross-match different phone numbers via the prefix-stripping path", () => {
    const result = findChatGuidForTest(chatsList, {
      kind: "chat_identifier",
      chatIdentifier: "iMessage;-;+18001234567",
    });
    expect(result).toBeNull();
  });

  it("does not match a DM target against a group's chat_identifier", () => {
    const result = findChatGuidForTest(chatsList, {
      kind: "chat_identifier",
      chatIdentifier: "iMessage;+;chat-not-here",
    });
    expect(result).toBeNull();
  });
});

describe("normalizeDirectChatIdentifier", () => {
  it("strips the iMessage;-; prefix", () => {
    expect(normalizeDirectChatIdentifierForTest("iMessage;-;+12069106512")).toBe("+12069106512");
  });
  it("strips the SMS;-; prefix", () => {
    expect(normalizeDirectChatIdentifierForTest("SMS;-;+12069106512")).toBe("+12069106512");
  });
  it("strips the any;-; prefix", () => {
    expect(normalizeDirectChatIdentifierForTest("any;-;+12069106512")).toBe("+12069106512");
  });
  it("matches case-insensitively", () => {
    expect(normalizeDirectChatIdentifierForTest("IMESSAGE;-;+12069106512")).toBe("+12069106512");
  });
  it("leaves group identifiers (iMessage;+;chat...) unchanged", () => {
    expect(normalizeDirectChatIdentifierForTest("iMessage;+;chat0000")).toBe("iMessage;+;chat0000");
    expect(normalizeDirectChatIdentifierForTest("iMessage;+;Some@example.com")).toBe(
      "iMessage;+;Some@example.com",
    );
  });
  it("leaves bare values unchanged", () => {
    expect(normalizeDirectChatIdentifierForTest("+12069106512")).toBe("+12069106512");
    expect(normalizeDirectChatIdentifierForTest("foo@bar.com")).toBe("foo@bar.com");
  });
});
