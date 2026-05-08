import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

const { imessageActionsRuntime, _findChatGuidForTest, _normalizeDirectChatIdentifierForTest } =
  await import("./actions.runtime.js");

function mockSpawnJsonResponse(payload: Record<string, unknown> = { success: true }) {
  spawnMock.mockImplementationOnce(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding: (encoding: string) => void };
      stderr: EventEmitter & { setEncoding: (encoding: string) => void };
      kill: (signal: string) => void;
    };
    child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    child.kill = vi.fn();
    queueMicrotask(() => {
      child.stdout.emit("data", `${JSON.stringify(payload)}\n`);
      child.emit("close", 0);
    });
    return child;
  });
}

describe("imessage actions runtime", () => {
  it("passes the configured Messages db path to private API bridge commands", async () => {
    mockSpawnJsonResponse();

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

    expect(spawnMock).toHaveBeenCalledWith(
      "imsg",
      [
        "tapback",
        "--chat",
        "iMessage;+;chat0000",
        "--message",
        "message-guid",
        "--kind",
        "like",
        "--part",
        "0",
        "--db",
        "/tmp/messages.db",
        "--json",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
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
    const result = _findChatGuidForTest(chatsList, {
      kind: "chat_identifier",
      chatIdentifier: "iMessage;-;+12069106512",
    });
    expect(result).toBe("any;-;+12069106512");
  });

  it("matches a synthesized SMS;-;<phone> target the same way", () => {
    const result = _findChatGuidForTest(chatsList, {
      kind: "chat_identifier",
      chatIdentifier: "SMS;-;+12069106512",
    });
    expect(result).toBe("any;-;+12069106512");
  });

  it("matches a bare <phone> identifier exactly", () => {
    const result = _findChatGuidForTest(chatsList, {
      kind: "chat_identifier",
      chatIdentifier: "+12069106512",
    });
    expect(result).toBe("any;-;+12069106512");
  });

  it("matches an any;-;<phone> guid form against the chats.list guid column", () => {
    const result = _findChatGuidForTest(chatsList, {
      kind: "chat_identifier",
      chatIdentifier: "any;-;+12069106512",
    });
    expect(result).toBe("any;-;+12069106512");
  });

  it("matches a group chat by exact guid", () => {
    const result = _findChatGuidForTest(chatsList, {
      kind: "chat_identifier",
      chatIdentifier: "iMessage;+;chat0000",
    });
    expect(result).toBe("iMessage;+;chat0000");
  });

  it("matches a group chat by chat_id", () => {
    const result = _findChatGuidForTest(chatsList, { kind: "chat_id", chatId: 7 });
    expect(result).toBe("iMessage;+;chat0000");
  });

  it("returns null for a phone number that does not exist in chats.list", () => {
    const result = _findChatGuidForTest(chatsList, {
      kind: "chat_identifier",
      chatIdentifier: "iMessage;-;+19999999999",
    });
    expect(result).toBeNull();
  });

  it("does not cross-match different phone numbers via the prefix-stripping path", () => {
    const result = _findChatGuidForTest(chatsList, {
      kind: "chat_identifier",
      chatIdentifier: "iMessage;-;+18001234567",
    });
    expect(result).toBeNull();
  });

  it("does not match a DM target against a group's chat_identifier", () => {
    const result = _findChatGuidForTest(chatsList, {
      kind: "chat_identifier",
      chatIdentifier: "iMessage;+;chat-not-here",
    });
    expect(result).toBeNull();
  });
});

describe("normalizeDirectChatIdentifier", () => {
  it("strips the iMessage;-; prefix", () => {
    expect(_normalizeDirectChatIdentifierForTest("iMessage;-;+12069106512")).toBe("+12069106512");
  });
  it("strips the SMS;-; prefix", () => {
    expect(_normalizeDirectChatIdentifierForTest("SMS;-;+12069106512")).toBe("+12069106512");
  });
  it("strips the any;-; prefix", () => {
    expect(_normalizeDirectChatIdentifierForTest("any;-;+12069106512")).toBe("+12069106512");
  });
  it("matches case-insensitively", () => {
    expect(_normalizeDirectChatIdentifierForTest("IMESSAGE;-;+12069106512")).toBe("+12069106512");
  });
  it("leaves group identifiers (iMessage;+;chat...) unchanged", () => {
    expect(_normalizeDirectChatIdentifierForTest("iMessage;+;chat0000")).toBe(
      "iMessage;+;chat0000",
    );
  });
  it("leaves bare values unchanged", () => {
    expect(_normalizeDirectChatIdentifierForTest("+12069106512")).toBe("+12069106512");
    expect(_normalizeDirectChatIdentifierForTest("foo@bar.com")).toBe("foo@bar.com");
  });
});
