// Matrix tests cover actions.account propagation plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelMessageActionContext } from "../runtime-api.js";
import type { CoreConfig } from "./types.js";

const mocks = vi.hoisted(() => ({
  handleMatrixAction: vi.fn(),
}));

vi.mock("./tool-actions.js", () => ({
  handleMatrixAction: mocks.handleMatrixAction,
}));

const { matrixMessageActions } = await import("./actions.js");

const profileAction = "set-profile" as ChannelMessageActionContext["action"];

function matrixActionCall() {
  const call = mocks.handleMatrixAction.mock.calls[0];
  if (!call) {
    throw new Error("expected handleMatrixAction call");
  }
  return {
    input: call[0] as Record<string, unknown>,
    cfg: call[1],
    options: call[2],
  };
}

function createContext(
  overrides: Partial<ChannelMessageActionContext>,
): ChannelMessageActionContext {
  return {
    channel: "matrix",
    action: "send",
    cfg: {
      channels: {
        matrix: {
          enabled: true,
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "token",
        },
      },
    } as CoreConfig,
    params: {},
    ...overrides,
  };
}

describe("matrixMessageActions account propagation", () => {
  beforeEach(() => {
    mocks.handleMatrixAction.mockReset().mockResolvedValue({
      ok: true,
      output: "",
      details: { ok: true },
    });
  });

  it("forwards accountId for send actions", async () => {
    await matrixMessageActions.handleAction?.(
      createContext({
        action: "send",
        accountId: "ops",
        params: {
          to: "room:!room:example",
          message: "hello",
        },
      }),
    );

    const call = matrixActionCall();
    expect(call.input.action).toBe("sendMessage");
    expect(call.input.accountId).toBe("ops");
    expect(call.cfg).toBeTypeOf("object");
    expect(call.options).toMatchObject({ mediaLocalRoots: undefined });
  });

  it.each([
    { action: "send" as const, expectedAction: "sendMessage", message: "    @room" },
    {
      action: "send" as const,
      expectedAction: "sendMessage",
      message: "    @alice:example.org",
    },
    { action: "edit" as const, expectedAction: "editMessage", message: "    @room" },
    {
      action: "edit" as const,
      expectedAction: "editMessage",
      message: "    @alice:example.org",
    },
  ])(
    "preserves leading Markdown indentation for $action with $message",
    async ({ action, expectedAction, message }) => {
      await matrixMessageActions.handleAction?.(
        createContext({
          action,
          accountId: "ops",
          params:
            action === "send"
              ? { to: "room:!room:example", message }
              : { roomId: "!room:example", messageId: "$original", message },
        }),
      );

      expect(matrixActionCall().input).toMatchObject({
        action: expectedAction,
        accountId: "ops",
        content: message,
      });
    },
  );

  it.each(["send", "edit"] as const)("rejects a missing %s message", async (action) => {
    await expect(
      matrixMessageActions.handleAction?.(
        createContext({
          action,
          params:
            action === "send"
              ? { to: "room:!room:example" }
              : { roomId: "!room:example", messageId: "$original" },
        }),
      ),
    ).rejects.toThrow("message required");
  });

  it("forwards accountId for permissions actions", async () => {
    await matrixMessageActions.handleAction?.(
      createContext({
        action: "permissions",
        accountId: "ops",
        senderIsOwner: true,
        params: {
          operation: "verification-list",
        },
      }),
    );

    const call = matrixActionCall();
    expect(call.input.action).toBe("verificationList");
    expect(call.input.accountId).toBe("ops");
    expect(call.cfg).toBeTypeOf("object");
    expect(call.options).toMatchObject({ mediaLocalRoots: undefined });
  });

  it("rejects verification actions without sender owner context", async () => {
    await expect(
      matrixMessageActions.handleAction?.(
        createContext({
          action: "permissions",
          accountId: "ops",
          senderIsOwner: false,
          params: {
            operation: "verification-bootstrap",
            forceResetCrossSigning: true,
            recoveryKey: "test-recovery-key",
          },
        }),
      ),
    ).rejects.toThrow("Matrix verification actions require owner access.");

    expect(mocks.handleMatrixAction).not.toHaveBeenCalled();
  });

  it("forwards accountId for self-profile updates", async () => {
    await matrixMessageActions.handleAction?.(
      createContext({
        action: profileAction,
        accountId: "ops",
        senderIsOwner: true,
        params: {
          displayName: "Ops Bot",
          avatarUrl: "mxc://example/avatar",
        },
      }),
    );

    const call = matrixActionCall();
    expect(call.input.action).toBe("setProfile");
    expect(call.input.accountId).toBe("ops");
    expect(call.input.displayName).toBe("Ops Bot");
    expect(call.input.avatarUrl).toBe("mxc://example/avatar");
    expect(call.cfg).toBeTypeOf("object");
    expect(call.options).toMatchObject({ mediaLocalRoots: undefined });
  });

  it("rejects self-profile updates without sender owner context", async () => {
    await expect(
      matrixMessageActions.handleAction?.(
        createContext({
          action: profileAction,
          accountId: "ops",
          params: {
            displayName: "Ops Bot",
          },
        }),
      ),
    ).rejects.toThrow("Matrix profile updates require owner access.");
  });

  it("dispatches self-profile updates with sender owner context", async () => {
    await matrixMessageActions.handleAction?.(
      createContext({
        action: profileAction,
        accountId: "ops",
        senderIsOwner: true,
        params: {
          displayName: "Ops Bot",
        },
      }),
    );

    const call = matrixActionCall();
    expect(call.input).toMatchObject({
      action: "setProfile",
      accountId: "ops",
      displayName: "Ops Bot",
    });
  });

  it("forwards local avatar paths for self-profile updates", async () => {
    await matrixMessageActions.handleAction?.(
      createContext({
        action: profileAction,
        accountId: "ops",
        senderIsOwner: true,
        params: {
          path: "/tmp/avatar.jpg",
        },
      }),
    );

    const call = matrixActionCall();
    expect(call.input.action).toBe("setProfile");
    expect(call.input.accountId).toBe("ops");
    expect(call.input.avatarPath).toBe("/tmp/avatar.jpg");
    expect(call.cfg).toBeTypeOf("object");
    expect(call.options).toMatchObject({ mediaLocalRoots: undefined });
  });

  it("forwards mediaLocalRoots for media sends", async () => {
    const mediaAccess = {
      localRoots: ["/tmp/openclaw-matrix-test"],
      readFile: async () => Buffer.from("chart"),
      workspaceDir: "/tmp/openclaw-matrix-test",
    };
    await matrixMessageActions.handleAction?.(
      createContext({
        action: "send",
        accountId: "ops",
        mediaAccess,
        mediaLocalRoots: mediaAccess.localRoots,
        params: {
          to: "room:!room:example",
          message: "hello",
          media: "chart.png",
        },
      }),
    );

    const call = matrixActionCall();
    expect(call.input.action).toBe("sendMessage");
    expect(call.input.accountId).toBe("ops");
    expect(call.input.mediaUrl).toBe("chart.png");
    expect(call.cfg).toBeTypeOf("object");
    expect(call.options.mediaAccess).toBe(mediaAccess);
    expect(call.options).toMatchObject({ mediaLocalRoots: ["/tmp/openclaw-matrix-test"] });
  });

  it("allows media-only sends without requiring a message body", async () => {
    await matrixMessageActions.handleAction?.(
      createContext({
        action: "send",
        accountId: "ops",
        params: {
          to: "room:!room:example",
          media: "file:///tmp/photo.png",
        },
      }),
    );

    const call = matrixActionCall();
    expect(call.input.action).toBe("sendMessage");
    expect(call.input.accountId).toBe("ops");
    expect(call.input.content).toBeUndefined();
    expect(call.input.mediaUrl).toBe("file:///tmp/photo.png");
    expect(call.cfg).toBeTypeOf("object");
    expect(call.options).toMatchObject({ mediaLocalRoots: undefined });
  });

  it("accepts shared media aliases and forwards voice-send intent", async () => {
    await matrixMessageActions.handleAction?.(
      createContext({
        action: "send",
        accountId: "ops",
        params: {
          to: "room:!room:example",
          filePath: "/tmp/clip.mp3",
          asVoice: true,
        },
      }),
    );

    const call = matrixActionCall();
    expect(call.input.action).toBe("sendMessage");
    expect(call.input.accountId).toBe("ops");
    expect(call.input.content).toBeUndefined();
    expect(call.input.mediaUrl).toBe("/tmp/clip.mp3");
    expect(call.input.audioAsVoice).toBe(true);
    expect(call.cfg).toBeTypeOf("object");
    expect(call.options).toMatchObject({ mediaLocalRoots: undefined });
  });

  it("forwards trusted conversation context for read authorization", async () => {
    await matrixMessageActions.handleAction?.(
      createContext({
        action: "reactions",
        accountId: "ops",
        requesterAccountId: "ops",
        params: {
          roomId: "!dm:example.org",
          messageId: "$event",
        },
        toolContext: {
          currentChannelId: "room:!dm:example.org",
          currentChannelProvider: "matrix",
          currentChatType: "direct",
        },
      }),
    );

    expect(matrixActionCall().options).toMatchObject({
      readContext: {
        accountId: "ops",
        requesterAccountId: "ops",
        currentChannelId: "room:!dm:example.org",
        currentChannelProvider: "matrix",
        currentChatType: "direct",
      },
    });
  });

  it("defaults custom-emote discovery to the bound current Matrix conversation", async () => {
    await matrixMessageActions.handleAction?.(
      createContext({
        action: "emoji-list",
        accountId: "ops",
        requesterAccountId: "ops",
        params: { limit: 3 },
        toolContext: {
          currentChannelId: "room:!current:example.org",
          currentChannelProvider: "matrix",
          currentChatType: "group",
        },
      }),
    );

    expect(matrixActionCall().input).toMatchObject({
      action: "emoji-list",
      accountId: "ops",
      roomId: "room:!current:example.org",
      limit: 3,
    });
    expect(matrixActionCall().options.readContext).toMatchObject({
      requesterAccountId: "ops",
      currentChannelId: "room:!current:example.org",
      currentChannelProvider: "matrix",
    });
  });

  it("rejects custom-emote discovery without an explicit room or bound Matrix conversation", async () => {
    await expect(
      matrixMessageActions.handleAction?.(
        createContext({
          action: "emoji-list",
          params: {},
          toolContext: {
            currentChannelId: "room:!foreign:example.org",
            currentChannelProvider: "slack",
          },
        }),
      ),
    ).rejects.toThrow("Matrix emoji-list requires a roomId or current Matrix conversation.");
    expect(mocks.handleMatrixAction).not.toHaveBeenCalled();
  });
});
