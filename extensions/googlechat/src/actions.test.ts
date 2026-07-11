// Googlechat tests cover actions plugin behavior.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const listEnabledGoogleChatAccounts = vi.hoisted(() => vi.fn());
const resolveGoogleChatAccount = vi.hoisted(() => vi.fn());
const sendGoogleChatMessage = vi.hoisted(() => vi.fn());
const resolveGoogleChatOutboundSpace = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  listEnabledGoogleChatAccounts,
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
        dm: { policy: "open" },
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
      actions: ["send"],
    });
    expect(googlechatMessageActions.supportsAction?.({ action: "send" })).toBe(true);
    expect(googlechatMessageActions.supportsAction?.({ action: "upload-file" })).toBe(false);
  });

  it("keeps the legacy reaction gate from changing account-scoped discovery", () => {
    resolveGoogleChatAccount.mockImplementation(({ accountId }: { accountId?: string | null }) => ({
      enabled: true,
      credentialSource: "service-account",
      config: {
        actions: { reactions: accountId === "work" },
      },
    }));

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
    { action: "send", params: { to: "spaces/AAA", message: "caption", media: "remote.png" } },
    {
      action: "send",
      params: { to: "spaces/AAA", message: "caption", mediaUrl: "remote.png" },
    },
    {
      action: "send",
      params: { to: "spaces/AAA", message: "caption", mediaUrls: ["remote.png"] },
    },
    {
      action: "send",
      params: { to: "spaces/AAA", message: "caption", fileUrl: "remote.png" },
    },
    {
      action: "send",
      params: {
        to: "spaces/AAA",
        message: "caption",
        attachments: [{ url: "remote.png" }],
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
      ).rejects.toThrow(
        "Google Chat outbound attachments require user OAuth and are not supported by this service-account channel.",
      );

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
