import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const listEnabledGoogleChatAccounts = vi.hoisted(() => vi.fn());
const resolveGoogleChatAccount = vi.hoisted(() => vi.fn());
const createGoogleChatReaction = vi.hoisted(() => vi.fn());
const deleteGoogleChatReaction = vi.hoisted(() => vi.fn());
const listGoogleChatReactions = vi.hoisted(() => vi.fn());
const sendGoogleChatMessage = vi.hoisted(() => vi.fn());
const uploadGoogleChatAttachment = vi.hoisted(() => vi.fn());
const resolveGoogleChatOutboundSpace = vi.hoisted(() => vi.fn());
const getGoogleChatRuntime = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  listEnabledGoogleChatAccounts,
  resolveGoogleChatAccount,
}));

vi.mock("./api.js", () => ({
  createGoogleChatReaction,
  deleteGoogleChatReaction,
  listGoogleChatReactions,
  sendGoogleChatMessage,
  uploadGoogleChatAttachment,
}));

vi.mock("./runtime.js", () => ({
  getGoogleChatRuntime,
}));

vi.mock("./targets.js", () => ({
  resolveGoogleChatOutboundSpace,
}));

let googlechatMessageActions: typeof import("./actions.js").googlechatMessageActions;

describe("googlechat message actions", () => {
  beforeAll(async () => {
    ({ googlechatMessageActions } = await import("./actions.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./api.js");
    vi.doUnmock("./runtime.js");
    vi.doUnmock("./targets.js");
    vi.resetModules();
  });

  it("describes send and reaction actions only when enabled accounts exist", async () => {
    listEnabledGoogleChatAccounts.mockReturnValueOnce([]);
    expect(googlechatMessageActions.describeMessageTool?.({ cfg: {} as never })).toBeNull();

    listEnabledGoogleChatAccounts.mockReturnValueOnce([
      {
        enabled: true,
        credentialSource: "service-account",
        config: { actions: { reactions: true } },
      },
    ]);

    expect(googlechatMessageActions.describeMessageTool?.({ cfg: {} as never })).toEqual({
      actions: ["send", "upload-file", "react", "reactions"],
    });
  });

  it("honors account-scoped reaction gates during discovery", () => {
    resolveGoogleChatAccount.mockImplementation(({ accountId }: { accountId?: string | null }) => ({
      enabled: true,
      credentialSource: "service-account",
      config: {
        actions: { reactions: accountId === "work" },
      },
    }));

    expect(
      googlechatMessageActions.describeMessageTool?.({ cfg: {} as never, accountId: "default" }),
    ).toEqual({
      actions: ["send", "upload-file"],
    });
    expect(
      googlechatMessageActions.describeMessageTool?.({ cfg: {} as never, accountId: "work" }),
    ).toEqual({
      actions: ["send", "upload-file", "react", "reactions"],
    });
  });

  it("sends messages with uploaded media through the resolved space", async () => {
    resolveGoogleChatAccount.mockReturnValue({
      credentialSource: "service-account",
      config: { mediaMaxMb: 5 },
    });
    resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/AAA");
    getGoogleChatRuntime.mockReturnValue({
      channel: {
        media: {
          fetchRemoteMedia: vi.fn(async () => ({
            buffer: Buffer.from("remote-bytes"),
            fileName: "remote.png",
            contentType: "image/png",
          })),
        },
      },
    });
    uploadGoogleChatAttachment.mockResolvedValue({
      attachmentUploadToken: "token-1",
    });
    sendGoogleChatMessage.mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-1",
    });

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    const result = await googlechatMessageActions.handleAction({
      action: "send",
      params: {
        to: "spaces/AAA",
        message: "caption",
        media: "https://example.com/file.png",
        threadId: "thread-1",
      },
      cfg: {},
      accountId: "default",
    } as never);

    expect(resolveGoogleChatOutboundSpace).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "spaces/AAA",
      }),
    );
    expect(uploadGoogleChatAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        space: "spaces/AAA",
        filename: "remote.png",
      }),
    );
    expect(sendGoogleChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        space: "spaces/AAA",
        text: "caption",
        thread: "thread-1",
      }),
    );
    expect(result).toMatchObject({
      details: {
        ok: true,
        to: "spaces/AAA",
      },
    });
  });

  it("routes upload-file through the same attachment upload path with filename override", async () => {
    resolveGoogleChatAccount.mockReturnValue({
      credentialSource: "service-account",
      config: { mediaMaxMb: 5 },
    });
    resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/BBB");
    const localRoot = "/tmp/googlechat-action-test";
    const localPath = path.join(localRoot, "local.md");
    const readFile = vi.fn(async () => Buffer.from("local-bytes"));
    getGoogleChatRuntime.mockReturnValue({
      channel: {
        media: {
          fetchRemoteMedia: vi.fn(),
        },
      },
    });
    uploadGoogleChatAttachment.mockResolvedValue({
      attachmentUploadToken: "token-2",
    });
    sendGoogleChatMessage.mockResolvedValue({
      messageName: "spaces/BBB/messages/msg-2",
    });

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    const result = await googlechatMessageActions.handleAction({
      action: "upload-file",
      params: {
        to: "spaces/BBB",
        path: localPath,
        message: "notes",
        filename: "renamed.txt",
      },
      cfg: {},
      accountId: "default",
      mediaLocalRoots: [localRoot],
      mediaReadFile: readFile,
    } as never);

    expect(readFile).toHaveBeenCalledWith(localPath);
    expect(uploadGoogleChatAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        space: "spaces/BBB",
        filename: "renamed.txt",
        buffer: Buffer.from("local-bytes"),
      }),
    );
    expect(sendGoogleChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        space: "spaces/BBB",
        text: "notes",
        attachments: [{ attachmentUploadToken: "token-2", contentName: "renamed.txt" }],
      }),
    );
    expect(result).toMatchObject({
      details: {
        ok: true,
        to: "spaces/BBB",
      },
    });
  });

  it("removes only matching app reactions on react remove", async () => {
    resolveGoogleChatAccount.mockReturnValue({
      credentialSource: "service-account",
      config: { botUser: "users/app-bot" },
    });
    listGoogleChatReactions.mockResolvedValue([
      {
        name: "reactions/1",
        emoji: { unicode: "👍" },
        user: { name: "users/app" },
      },
      {
        name: "reactions/2",
        emoji: { unicode: "👍" },
        user: { name: "users/app-bot" },
      },
      {
        name: "reactions/3",
        emoji: { unicode: "👍" },
        user: { name: "users/other" },
      },
    ]);

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    const result = await googlechatMessageActions.handleAction({
      action: "react",
      params: {
        messageId: "spaces/AAA/messages/msg-1",
        emoji: "👍",
        remove: true,
      },
      cfg: {},
      accountId: "default",
    } as never);

    expect(deleteGoogleChatReaction).toHaveBeenCalledTimes(2);
    expect(deleteGoogleChatReaction).toHaveBeenNthCalledWith(1, {
      account: expect.anything(),
      reactionName: "reactions/1",
    });
    expect(deleteGoogleChatReaction).toHaveBeenNthCalledWith(2, {
      account: expect.anything(),
      reactionName: "reactions/2",
    });
    expect(result).toMatchObject({
      details: {
        ok: true,
        removed: 2,
      },
    });
  });
});
