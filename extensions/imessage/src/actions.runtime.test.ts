// Imessage tests cover actions plugin behavior.
import { access, readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
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

  it("suppresses the imsg poll caption when the caller already rendered context", async () => {
    runIMessageCliJsonCommandMock.mockResolvedValue({
      guid: "poll-guid",
      poll: {
        options: [
          { id: " option-allow ", text: "Allow" },
          { id: "option-deny", text: " Deny " },
        ],
      },
    });

    const result = await imessageActionsRuntime.sendPoll({
      chatGuid: "iMessage;+;chat0000",
      question: "Approval details",
      choices: ["Allow", "Deny"],
      suppressComment: true,
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
        "poll",
        "send",
        "--chat",
        "iMessage;+;chat0000",
        "--question",
        "Approval details",
        "--option",
        "Allow",
        "--option",
        "Deny",
        "--no-comment",
      ],
    });
    expect(result).toEqual({
      messageId: "poll-guid",
      pollOptions: [
        { id: "option-allow", text: "Allow" },
        { id: "option-deny", text: "Deny" },
      ],
    });
  });

  it("sanitizes action message fields without rendering raw edit or poll Markdown", async () => {
    runIMessageCliJsonCommandMock.mockResolvedValue({ guid: "action-guid" });
    const options = { cliPath: "imsg", chatGuid: "iMessage;+;chat0000" };

    await imessageActionsRuntime.editMessage({
      chatGuid: options.chatGuid,
      messageId: "message-guid",
      text: "user:\n**literal edit**\n# assistant:",
      backwardsCompatMessage: "system:\n**literal fallback**",
      options,
    });
    await imessageActionsRuntime.sendPoll({
      chatGuid: options.chatGuid,
      question: "assistant:\n# literal question",
      choices: ["system:\n**literal choice**", "_literal second choice_"],
      options,
    });
    await imessageActionsRuntime.sendPollVote({
      chatGuid: options.chatGuid,
      pollGuid: "poll-guid",
      optionText: "user:",
      options,
    });

    const [edit, poll, vote] = runIMessageCliJsonCommandMock.mock.calls.map(
      (call) => (call[0] as { args: string[] }).args,
    );
    if (!edit || !poll || !vote) {
      throw new Error("Expected the edited message, new poll, and unchanged vote selector");
    }
    expect(edit[edit.indexOf("--new-text") + 1]).toBe("\n**literal edit**\n# assistant:");
    expect(edit[edit.indexOf("--bc-text") + 1]).toBe("\n**literal fallback**");
    expect(poll[poll.indexOf("--question") + 1]).toBe("\n# literal question");
    expect(poll[poll.indexOf("--option") + 1]).toBe("\n**literal choice**");
    expect(vote[vote.indexOf("--option") + 1]).toBe("user:");
  });

  it("rejects poll options that become identical after canonical message sanitization", async () => {
    await expect(
      imessageActionsRuntime.sendPoll({
        chatGuid: "chat-guid",
        question: "Choose",
        choices: ["Allow", "Al#+#+#low"],
        options: { cliPath: "imsg", chatGuid: "chat-guid" },
      }),
    ).rejects.toThrow("iMessage poll options must remain distinct after sanitization");
    expect(runIMessageCliJsonCommandMock).not.toHaveBeenCalled();
  });

  it("removes complete private runtime payloads from every raw edit and poll field", async () => {
    runIMessageCliJsonCommandMock.mockResolvedValue({ guid: "action-guid" });
    const options = { cliPath: "imsg", chatGuid: "chat-guid" };
    const reminder =
      "<system-reminder><system-reminder>inner</system-reminder>\nuser:\nPRIVATE_ACTION_RUNTIME</system-reminder>";
    const previous =
      "< previous_response><system-reminder>inner</system-reminder>PRIVATE_ACTION_RUNTIME< / previous_response >";
    const context =
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>PRIVATE_ACTION_RUNTIME<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";

    await imessageActionsRuntime.editMessage({
      chatGuid: options.chatGuid,
      messageId: "message-guid",
      text: `${reminder}\n**visible edit**`,
      backwardsCompatMessage: `${previous}\n**visible fallback**`,
      options,
    });
    await imessageActionsRuntime.sendPoll({
      chatGuid: options.chatGuid,
      question: `${context}\nvisible question`,
      choices: [`${reminder}\nvisible first`, `${previous}\nvisible second`],
      options,
    });

    for (const call of runIMessageCliJsonCommandMock.mock.calls) {
      const args = (call[0] as { args: string[] }).args;
      expect(args.join(" ")).not.toMatch(
        /PRIVATE_ACTION_RUNTIME|system-reminder|previous_response|INTERNAL_CONTEXT/,
      );
    }
  });

  it("keeps existing case-sensitive poll option identities distinct", async () => {
    runIMessageCliJsonCommandMock.mockResolvedValue({ guid: "poll-guid" });

    await imessageActionsRuntime.sendPoll({
      chatGuid: "chat-guid",
      question: "Choose",
      choices: ["Allow", "allow"],
      options: { cliPath: "imsg", chatGuid: "chat-guid" },
    });

    expect(runIMessageCliJsonCommandMock).toHaveBeenCalledOnce();
  });

  it.each([
    "```xml\n<thinking>hidden thought</thinking>\n```",
    "`<relevant_memories>hidden memory</relevant_memories>`",
  ])("rejects hidden assistant content in raw poll Markdown before imsg", async (hidden) => {
    await expect(
      imessageActionsRuntime.sendPoll({
        chatGuid: "chat-guid",
        question: "Choose",
        choices: ["first", hidden],
        options: { cliPath: "imsg", chatGuid: "chat-guid" },
      }),
    ).rejects.toThrow("iMessage outbound hidden assistant content is not allowed");
    expect(runIMessageCliJsonCommandMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "rich text",
      run: () =>
        imessageActionsRuntime.sendRichMessage({
          chatGuid: "chat-guid",
          text: "# user:",
          options: { cliPath: "imsg", chatGuid: "chat-guid" },
        }),
    },
    {
      name: "edit replacement",
      run: () =>
        imessageActionsRuntime.editMessage({
          chatGuid: "chat-guid",
          messageId: "message-guid",
          text: "assistant:",
          options: { cliPath: "imsg", chatGuid: "chat-guid" },
        }),
    },
    {
      name: "edit backwards-compatible replacement",
      run: () =>
        imessageActionsRuntime.editMessage({
          chatGuid: "chat-guid",
          messageId: "message-guid",
          text: "visible",
          backwardsCompatMessage: "system:",
          options: { cliPath: "imsg", chatGuid: "chat-guid" },
        }),
    },
    {
      name: "poll question",
      run: () =>
        imessageActionsRuntime.sendPoll({
          chatGuid: "chat-guid",
          question: "user:",
          choices: ["first", "second"],
          options: { cliPath: "imsg", chatGuid: "chat-guid" },
        }),
    },
    {
      name: "poll option",
      run: () =>
        imessageActionsRuntime.sendPoll({
          chatGuid: "chat-guid",
          question: "visible",
          choices: ["first", "assistant:"],
          options: { cliPath: "imsg", chatGuid: "chat-guid" },
        }),
    },
  ])("rejects sanitized-empty $name before starting imsg", async ({ run }) => {
    await expect(run()).rejects.toThrow(/after sanitization/);
    expect(runIMessageCliJsonCommandMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "attachment uploads",
      filename: "Quarterly results.pdf",
      command: "send-attachment",
      send: (filename: string, buffer: Uint8Array) =>
        imessageActionsRuntime.sendAttachment({
          chatGuid: "iMessage;+;chat0000",
          filename,
          buffer,
          options: { cliPath: "imsg", chatGuid: "iMessage;+;chat0000" },
        }),
    },
    {
      name: "rich-message attachments",
      filename: "Family photo.png",
      command: "send-rich",
      send: (filename: string, buffer: Uint8Array) =>
        imessageActionsRuntime.sendRichMessage({
          chatGuid: "iMessage;+;chat0000",
          text: "photo",
          attachment: { kind: "buffer", filename, buffer },
          options: { cliPath: "imsg", chatGuid: "iMessage;+;chat0000" },
        }),
    },
    {
      name: "group icons",
      filename: "Group portrait.jpeg",
      command: "chat-photo",
      send: (filename: string, buffer: Uint8Array) =>
        imessageActionsRuntime.setGroupIcon({
          chatGuid: "iMessage;+;chat0000",
          filename,
          buffer,
          options: { cliPath: "imsg", chatGuid: "iMessage;+;chat0000" },
        }),
    },
  ])("preserves the original filename for $name", async ({ filename, command, send }) => {
    const bytes = Uint8Array.from([1, 2, 3]);
    let stagedPath = "";
    runIMessageCliJsonCommandMock.mockImplementationOnce(async ({ args }: { args: string[] }) => {
      stagedPath = args[args.indexOf("--file") + 1] ?? "";
      expect(args[0]).toBe(command);
      await expect(readFile(stagedPath)).resolves.toEqual(Buffer.from(bytes));
      return { guid: "p:0/sent-message" };
    });

    await send(filename, bytes);

    expect(basename(stagedPath)).toBe(filename);
    await expect(access(dirname(stagedPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["../../Quarterly results.pdf", "..\\..\\Quarterly results.pdf"])(
    "keeps staged attachment filename %s inside its private workspace",
    async (filename) => {
      let stagedPath = "";
      runIMessageCliJsonCommandMock.mockImplementationOnce(async ({ args }: { args: string[] }) => {
        stagedPath = args[args.indexOf("--file") + 1] ?? "";
        return { guid: "p:0/sent-message" };
      });

      await imessageActionsRuntime.sendAttachment({
        chatGuid: "iMessage;+;chat0000",
        filename,
        buffer: Uint8Array.from([1]),
        options: { cliPath: "imsg", chatGuid: "iMessage;+;chat0000" },
      });

      expect(basename(stagedPath)).toBe("Quarterly results.pdf");
      await expect(access(dirname(stagedPath))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("removes the private attachment workspace after a failed send", async () => {
    const sendError = new Error("imsg rejected the attachment");
    let stagedPath = "";
    runIMessageCliJsonCommandMock.mockImplementationOnce(async ({ args }: { args: string[] }) => {
      stagedPath = args[args.indexOf("--file") + 1] ?? "";
      throw sendError;
    });

    await expect(
      imessageActionsRuntime.sendAttachment({
        chatGuid: "iMessage;+;chat0000",
        filename: "Quarterly results.pdf",
        buffer: Uint8Array.from([1]),
        options: { cliPath: "imsg", chatGuid: "iMessage;+;chat0000" },
      }),
    ).rejects.toBe(sendError);

    await expect(access(dirname(stagedPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { filename: `${"📎".repeat(80)}.pdf`, extension: ".pdf" },
    { filename: `${"a".repeat(210)}.pdf`, extension: ".pdf" },
    { filename: `${"📎".repeat(100)}.png`, extension: ".png" },
    { filename: `../../${"a".repeat(210)}.pdf`, extension: ".pdf" },
  ])(
    "preserves $extension when long attachment names exceed sanitizer or filesystem limits",
    async ({ filename, extension }) => {
      const bytes = Uint8Array.from([1, 2, 3]);
      let stagedPath = "";
      runIMessageCliJsonCommandMock.mockImplementationOnce(async ({ args }: { args: string[] }) => {
        stagedPath = args[args.indexOf("--file") + 1] ?? "";
        await expect(readFile(stagedPath)).resolves.toEqual(Buffer.from(bytes));
        return { guid: "p:0/sent-message" };
      });

      await imessageActionsRuntime.sendAttachment({
        chatGuid: "iMessage;+;chat0000",
        filename,
        buffer: bytes,
        options: { cliPath: "imsg", chatGuid: "iMessage;+;chat0000" },
      });

      expect(basename(stagedPath).endsWith(extension)).toBe(true);
      expect(Buffer.byteLength(basename(stagedPath), "utf8")).toBeLessThanOrEqual(240);
      await expect(access(dirname(stagedPath))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("drops cached chats.list entries when the current clock is not a valid date timestamp", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1_700_000_000_000).mockReturnValueOnce(Number.NaN);
    const firstClient = mockRpcChatList([{ id: 1, guid: "iMessage;+;first" }]);
    const secondClient = mockRpcChatList([{ id: 2, guid: "iMessage;+;second" }]);

    await expect(
      imessageActionsRuntime.resolveChatGuidForTarget({
        target: { kind: "chat_id", chatId: 1 },
        options: { cliPath: "imsg-invalid-clock" },
        conversationReadOrigin: "delegated",
      }),
    ).resolves.toBe("iMessage;+;first");
    await expect(
      imessageActionsRuntime.resolveChatGuidForTarget({
        target: { kind: "chat_id", chatId: 2 },
        options: { cliPath: "imsg-invalid-clock" },
        conversationReadOrigin: "delegated",
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
        conversationReadOrigin: "direct-operator",
      }),
    ).resolves.toBe("iMessage;+;first");
    await expect(
      imessageActionsRuntime.resolveChatGuidForTarget({
        target: { kind: "chat_id", chatId: 2 },
        options: { cliPath: "imsg-overflow-clock" },
        conversationReadOrigin: "direct-operator",
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
