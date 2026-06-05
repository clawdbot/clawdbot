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
    expect(call.options).toEqual({ mediaLocalRoots: undefined });
  });

  it("forwards accountId for permissions actions", async () => {
    await matrixMessageActions.handleAction?.(
      createContext({
        action: "permissions",
        accountId: "ops",
        params: {
          operation: "verification-list",
        },
      }),
    );

    const call = matrixActionCall();
    expect(call.input.action).toBe("verificationList");
    expect(call.input.accountId).toBe("ops");
    expect(call.cfg).toBeTypeOf("object");
    expect(call.options).toEqual({ mediaLocalRoots: undefined });
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
    expect(call.options).toEqual({ mediaLocalRoots: undefined });
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
    expect(call.options).toEqual({ mediaLocalRoots: undefined });
  });

  it("forwards mediaLocalRoots for media sends", async () => {
    await matrixMessageActions.handleAction?.(
      createContext({
        action: "send",
        accountId: "ops",
        mediaLocalRoots: ["/tmp/openclaw-matrix-test"],
        params: {
          to: "room:!room:example",
          message: "hello",
          media: "file:///tmp/photo.png",
        },
      }),
    );

    const call = matrixActionCall();
    expect(call.input.action).toBe("sendMessage");
    expect(call.input.accountId).toBe("ops");
    expect(call.input.mediaUrl).toBe("file:///tmp/photo.png");
    expect(call.cfg).toBeTypeOf("object");
    expect(call.options).toEqual({ mediaLocalRoots: ["/tmp/openclaw-matrix-test"] });
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
    expect(call.options).toEqual({ mediaLocalRoots: undefined });
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
    expect(call.options).toEqual({ mediaLocalRoots: undefined });
  });
});
