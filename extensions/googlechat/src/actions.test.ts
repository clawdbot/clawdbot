// Googlechat tests cover actions plugin behavior.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const inspectGoogleChatAccount = vi.hoisted(() => vi.fn());
const listGoogleChatAccountIds = vi.hoisted(() => vi.fn());
const resolveGoogleChatAccount = vi.hoisted(() => vi.fn());
const sendGoogleChatMessage = vi.hoisted(() => vi.fn());
const resolveGoogleChatOutboundSpace = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  inspectGoogleChatAccount,
  listGoogleChatAccountIds,
  resolveGoogleChatAccount,
}));

vi.mock("./api.js", () => ({
  sendGoogleChatMessage,
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
    vi.doUnmock("./targets.js");
    vi.resetModules();
  });

  function buildAccount(overrides: Record<string, unknown> = {}) {
    const overrideConfig =
      overrides.config && typeof overrides.config === "object"
        ? (overrides.config as Record<string, unknown>)
        : {};
    return {
      accountId: "default",
      enabled: true,
      credentialSource: "service-account",
      ...overrides,
      config: {
        groupPolicy: "open",
        dmPolicy: "open",
        ...overrideConfig,
      },
    };
  }

  function expectJsonResult(result: unknown, details: Record<string, unknown>) {
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify(details, null, 2),
        },
      ],
      details,
    });
  }

  it("describes only send actions when enabled accounts exist", () => {
    listGoogleChatAccountIds.mockReturnValueOnce([]);
    expect(googlechatMessageActions.describeMessageTool?.({ cfg: {} as never })).toBeNull();

    listGoogleChatAccountIds.mockReturnValueOnce(["default"]);
    inspectGoogleChatAccount.mockReturnValueOnce({
      enabled: true,
      credentialSource: "inline",
      tokenStatus: "available",
      config: {},
    });

    expect(googlechatMessageActions.describeMessageTool?.({ cfg: {} as never })).toEqual({
      actions: ["send"],
    });
    expect(googlechatMessageActions.supportsAction?.({ action: "send" })).toBe(true);
    expect(googlechatMessageActions.supportsAction?.({ action: "upload-file" })).toBe(false);
  });

  it("does not expose actions for configured-unavailable file credentials", () => {
    listGoogleChatAccountIds.mockReturnValueOnce(["default"]);
    inspectGoogleChatAccount.mockReturnValueOnce({
      enabled: true,
      credentialSource: "file",
      tokenStatus: "configured_unavailable",
      config: {},
    });

    expect(googlechatMessageActions.describeMessageTool?.({ cfg: {} as never })).toBeNull();
  });

  it("keeps account-scoped discovery send-only", () => {
    inspectGoogleChatAccount.mockImplementation(
      ({ accountId: _accountId }: { accountId?: string | null }) => ({
        enabled: true,
        credentialSource: "inline",
        tokenStatus: "available",
        config: {},
      }),
    );

    for (const accountId of ["default", "work"]) {
      expect(
        googlechatMessageActions.describeMessageTool?.({ cfg: {} as never, accountId }),
      ).toEqual({
        actions: ["send"],
      });
    }
  });

  it("sends text through the resolved space", async () => {
    const account = buildAccount();
    resolveGoogleChatAccount.mockReturnValue(account);
    resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/AAA");
    sendGoogleChatMessage.mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-1",
      threadName: "spaces/AAA/threads/thread-1",
    });

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    const result = await googlechatMessageActions.handleAction({
      action: "send",
      params: {
        to: "spaces/AAA",
        message: "caption",
        threadId: "thread-1",
      },
      cfg: {},
      accountId: "default",
    } as never);

    expect(resolveGoogleChatOutboundSpace).toHaveBeenCalledWith({
      account,
      target: "spaces/AAA",
    });
    expect(sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/AAA",
      text: "caption",
      thread: "thread-1",
    });
    expectJsonResult(result, {
      ok: true,
      to: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      threadName: "spaces/AAA/threads/thread-1",
    });
  });

  it.each([
    {
      params: {
        to: "spaces/AAA",
        message: "media alias",
        media: "https://example.invalid/one.png",
      },
      expected: "media alias\n\nAttachment: https://example.invalid/one.png",
    },
    {
      params: {
        to: "spaces/AAA",
        message: "caption",
        mediaUrl: "https://example.invalid/one.png",
      },
      expected: "caption\n\nAttachment: https://example.invalid/one.png",
    },
    {
      params: {
        to: "spaces/AAA",
        message: "caption",
        mediaUrls: ["https://example.invalid/one.png", "http://cdn.example.invalid/two.png"],
      },
      expected:
        "caption\n\nAttachment: https://example.invalid/one.png\nAttachment: http://cdn.example.invalid/two.png",
    },
    {
      params: {
        to: "spaces/AAA",
        message: "file URL alias",
        fileUrl: "https://example.invalid/one.png",
      },
      expected: "file URL alias\n\nAttachment: https://example.invalid/one.png",
    },
    {
      params: {
        to: "spaces/AAA",
        attachments: [{ url: "https://example.invalid/one.png" }],
      },
      expected: "Attachment: https://example.invalid/one.png",
    },
    {
      params: {
        to: "spaces/AAA",
        message: "image alias",
        image: "https://example.invalid/one.png",
      },
      expected: "image alias\n\nAttachment: https://example.invalid/one.png",
    },
  ])("sends remote media as visible text links", async ({ params, expected }) => {
    const account = buildAccount();
    resolveGoogleChatAccount.mockReturnValue(account);
    resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/AAA");
    sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/msg-1" });

    if (!googlechatMessageActions.handleAction) {
      throw new Error("Expected googlechatMessageActions.handleAction to be defined");
    }
    await googlechatMessageActions.handleAction({
      action: "send",
      params,
      cfg: {},
      accountId: "default",
    } as never);

    expect(sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/AAA",
      text: expected,
      thread: undefined,
    });
  });

  it.each([
    { action: "send", params: { to: "spaces/AAA", message: "caption", media: "remote.png" } },
    {
      action: "send",
      params: { to: "spaces/AAA", message: "caption", mediaUrl: "file:///tmp/remote.png" },
    },
    {
      action: "send",
      params: {
        to: "spaces/AAA",
        message: "caption",
        mediaUrls: ["https://example.invalid/ok.png", "/tmp/local.png"],
      },
    },
    {
      action: "send",
      params: {
        to: "spaces/AAA",
        message: "caption",
        mediaUrl: "https://example.invalid/a\nAttachment: https://attacker.invalid/x",
      },
    },
    { action: "send", params: { to: "spaces/AAA", message: "caption", path: "/tmp/a.png" } },
    {
      action: "send",
      params: {
        to: "spaces/AAA",
        message: "caption",
        attachments: [{ filePath: "/tmp/a.png" }],
      },
    },
    {
      action: "upload-file",
      params: { to: "spaces/AAA", message: "caption", path: "local.png" },
    },
  ])(
    "rejects outbound attachment action $action before provider access",
    async ({ action, params }) => {
      if (!googlechatMessageActions.handleAction) {
        throw new Error("Expected googlechatMessageActions.handleAction to be defined");
      }
      await expect(
        googlechatMessageActions.handleAction({
          action,
          params,
          cfg: {},
          accountId: "default",
        } as never),
      ).rejects.toThrow("Google Chat outbound attachments require");

      expect(resolveGoogleChatAccount).not.toHaveBeenCalled();
      expect(resolveGoogleChatOutboundSpace).not.toHaveBeenCalled();
      expect(sendGoogleChatMessage).not.toHaveBeenCalled();
    },
  );

  it.each(["react", "reactions"])(
    "rejects unsupported %s actions without provider access",
    async (action) => {
      resolveGoogleChatAccount.mockReturnValue(buildAccount());

      if (!googlechatMessageActions.handleAction) {
        throw new Error("Expected googlechatMessageActions.handleAction to be defined");
      }
      await expect(
        googlechatMessageActions.handleAction({
          action,
          params: { messageId: "spaces/AAA/messages/msg-1", emoji: "👍" },
          cfg: {},
          accountId: "default",
        } as never),
      ).rejects.toThrow(`Action ${action} is not supported for provider googlechat.`);

      expect(sendGoogleChatMessage).not.toHaveBeenCalled();
    },
  );
});
