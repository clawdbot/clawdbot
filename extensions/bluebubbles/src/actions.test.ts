import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { sendBlueBubblesAttachment } from "./attachments.js";
import { editBlueBubblesMessage, setGroupIconBlueBubbles } from "./chat.js";
import { resolveBlueBubblesMessageId } from "./monitor-reply-cache.js";
import { getCachedBlueBubblesPrivateApiStatus } from "./probe.js";
import { sendBlueBubblesReaction } from "./reactions.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { resolveChatGuidForTarget, sendMessageBlueBubbles } from "./send.js";

vi.mock("./accounts.js", async () => {
  const { createBlueBubblesAccountsMockModule } = await import("./test-harness.js");
  return createBlueBubblesAccountsMockModule();
});

vi.mock("./reactions.js", () => ({
  sendBlueBubblesReaction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./send.js", () => ({
  resolveChatGuidForTarget: vi.fn().mockResolvedValue("iMessage;-;+15551234567"),
  sendMessageBlueBubbles: vi.fn().mockResolvedValue({ messageId: "msg-123" }),
}));

vi.mock("./chat.js", () => ({
  editBlueBubblesMessage: vi.fn().mockResolvedValue(undefined),
  unsendBlueBubblesMessage: vi.fn().mockResolvedValue(undefined),
  renameBlueBubblesChat: vi.fn().mockResolvedValue(undefined),
  setGroupIconBlueBubbles: vi.fn().mockResolvedValue(undefined),
  addBlueBubblesParticipant: vi.fn().mockResolvedValue(undefined),
  removeBlueBubblesParticipant: vi.fn().mockResolvedValue(undefined),
  leaveBlueBubblesChat: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./attachments.js", () => ({
  sendBlueBubblesAttachment: vi.fn().mockResolvedValue({ messageId: "att-msg-123" }),
}));

vi.mock("./monitor-reply-cache.js", () => ({
  resolveBlueBubblesMessageId: vi.fn((id: string) => id),
}));

vi.mock("./probe.js", () => ({
  isMacOS26OrHigher: vi.fn().mockReturnValue(false),
  getCachedBlueBubblesPrivateApiStatus: vi.fn().mockReturnValue(null),
}));

const { bluebubblesMessageActions } = await importFreshModule<typeof import("./actions.js")>(
  import.meta.url,
  "./actions.js?actions-test",
);

function requireDefined<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`${name} is not registered`);
  }
  return value;
}

describe("bluebubblesMessageActions", () => {
  const describeMessageTool = requireDefined(
    bluebubblesMessageActions.describeMessageTool,
    "describeMessageTool",
  );
  const supportsAction = requireDefined(bluebubblesMessageActions.supportsAction, "supportsAction");
  const extractToolSend = requireDefined(
    bluebubblesMessageActions.extractToolSend,
    "extractToolSend",
  );
  const handleAction = requireDefined(bluebubblesMessageActions.handleAction, "handleAction");
  const callHandleAction = (ctx: Omit<Parameters<typeof handleAction>[0], "channel">) =>
    handleAction({ channel: "bluebubbles", ...ctx });
  const blueBubblesConfig = (): OpenClawConfig => ({
    channels: {
      bluebubbles: {
        serverUrl: "http://localhost:1234",
        password: "test-password",
      },
    },
  });
  const runReactAction = async (params: Record<string, unknown>) => {
    return await callHandleAction({
      action: "react",
      params,
      cfg: blueBubblesConfig(),
      accountId: null,
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedBlueBubblesPrivateApiStatus).mockReturnValue(null);
  });

  describe("describeMessageTool", () => {
    it("returns empty array when account is not enabled", () => {
      const cfg: OpenClawConfig = {
        channels: { bluebubbles: { enabled: false } },
      };
      const actions = describeMessageTool({ cfg })?.actions ?? [];
      expect(actions).toEqual([]);
    });

    it("returns empty array when account is not configured", () => {
      const cfg: OpenClawConfig = {
        channels: { bluebubbles: { enabled: true } },
      };
      const actions = describeMessageTool({ cfg })?.actions ?? [];
      expect(actions).toEqual([]);
    });

    it("returns react action when enabled and configured", () => {
      const cfg: OpenClawConfig = {
        channels: {
          bluebubbles: {
            enabled: true,
            serverUrl: "http://localhost:1234",
            password: "test-password",
          },
        },
      };
      const actions = describeMessageTool({ cfg })?.actions ?? [];
      expect(actions).toContain("react");
    });

    it("excludes react action when reactions are gated off", () => {
      const cfg: OpenClawConfig = {
        channels: {
          bluebubbles: {
            enabled: true,
            serverUrl: "http://localhost:1234",
            password: "test-password",
            actions: { reactions: false },
          },
        },
      };
      const actions = describeMessageTool({ cfg })?.actions ?? [];
      expect(actions).not.toContain("react");
      // Other actions should still be present
      expect(actions).toContain("edit");
      expect(actions).toContain("unsend");
    });

    it("honors account-scoped action gates during discovery", () => {
      const cfg: OpenClawConfig = {
        channels: {
          bluebubbles: {
            serverUrl: "http://localhost:1234",
            password: "test-password",
            actions: { reactions: false },
            accounts: {
              work: {
                serverUrl: "http://localhost:5678",
                password: "work-password",
                actions: { reactions: true },
              },
            },
          },
        },
      };

      expect(describeMessageTool({ cfg, accountId: "default" })?.actions).not.toContain("react");
      expect(describeMessageTool({ cfg, accountId: "work" })?.actions).toContain("react");
    });

    it("hides private-api actions when private API is disabled", () => {
      vi.mocked(getCachedBlueBubblesPrivateApiStatus).mockReturnValueOnce(false);
      const cfg: OpenClawConfig = {
        channels: {
          bluebubbles: {
            enabled: true,
            serverUrl: "http://localhost:1234",
            password: "test-password",
          },
        },
      };
      const actions = describeMessageTool({ cfg })?.actions ?? [];
      expect(actions).toContain("upload-file");
      expect(actions).not.toContain("sendAttachment");
      expect(actions).not.toContain("react");
      expect(actions).not.toContain("reply");
      expect(actions).not.toContain("sendWithEffect");
      expect(actions).not.toContain("edit");
      expect(actions).not.toContain("unsend");
      expect(actions).not.toContain("renameGroup");
      expect(actions).not.toContain("setGroupIcon");
      expect(actions).not.toContain("addParticipant");
      expect(actions).not.toContain("removeParticipant");
      expect(actions).not.toContain("leaveGroup");
    });
  });

  describe("supportsAction", () => {
    it("returns true for react action", () => {
      expect(supportsAction({ action: "react" })).toBe(true);
    });

    it("returns true for all supported actions", () => {
      expect(supportsAction({ action: "edit" })).toBe(true);
      expect(supportsAction({ action: "unsend" })).toBe(true);
      expect(supportsAction({ action: "reply" })).toBe(true);
      expect(supportsAction({ action: "sendWithEffect" })).toBe(true);
      expect(supportsAction({ action: "renameGroup" })).toBe(true);
      expect(supportsAction({ action: "setGroupIcon" })).toBe(true);
      expect(supportsAction({ action: "addParticipant" })).toBe(true);
      expect(supportsAction({ action: "removeParticipant" })).toBe(true);
      expect(supportsAction({ action: "leaveGroup" })).toBe(true);
      expect(supportsAction({ action: "sendAttachment" })).toBe(true);
      expect(supportsAction({ action: "upload-file" })).toBe(true);
    });

    it("returns false for unsupported actions", () => {
      expect(supportsAction({ action: "delete" as never })).toBe(false);
      expect(supportsAction({ action: "unknown" as never })).toBe(false);
    });
  });

  describe("extractToolSend", () => {
    it("extracts send params from sendMessage action", () => {
      const result = extractToolSend({
        args: {
          action: "sendMessage",
          to: "+15551234567",
          accountId: "test-account",
        },
      });
      expect(result).toEqual({
        to: "+15551234567",
        accountId: "test-account",
      });
    });

    it("returns null for non-sendMessage action", () => {
      const result = extractToolSend({
        args: { action: "react", to: "+15551234567" },
      });
      expect(result).toBeNull();
    });

    it("returns null when to is missing", () => {
      const result = extractToolSend({
        args: { action: "sendMessage" },
      });
      expect(result).toBeNull();
    });
  });

  describe("handleAction", () => {
    it("maps upload-file to the attachment runtime using canonical naming", async () => {
      const result = await callHandleAction({
        action: "upload-file",
        params: {
          to: "+15551234567",
          filename: "photo.png",
          buffer: Buffer.from("img").toString("base64"),
          message: "caption",
          contentType: "image/png",
        },
        cfg: blueBubblesConfig(),
        accountId: null,
      });

      expect(sendBlueBubblesAttachment).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "+15551234567",
          filename: "photo.png",
          caption: "caption",
          contentType: "image/png",
        }),
      );
      expect(result).toMatchObject({
        details: {
          ok: true,
          messageId: "att-msg-123",
        },
      });
    });

    it("throws for unsupported actions", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          bluebubbles: {
            serverUrl: "http://localhost:1234",
            password: "test-password",
          },
        },
      };
      await expect(
        callHandleAction({
          action: "unknownAction" as never,
          params: {},
          cfg,
          accountId: null,
        }),
      ).rejects.toThrow("is not supported");
    });

    it("throws when emoji is missing for react action", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          bluebubbles: {
            serverUrl: "http://localhost:1234",
            password: "test-password",
          },
        },
      };
      await expect(
        callHandleAction({
          action: "react",
          params: { messageId: "msg-123" },
          cfg,
          accountId: null,
        }),
      ).rejects.toThrow(/emoji/i);
    });

    it("throws a private-api error for private-only actions when disabled", async () => {
      vi.mocked(getCachedBlueBubblesPrivateApiStatus).mockReturnValueOnce(false);
      const cfg: OpenClawConfig = {
        channels: {
          bluebubbles: {
            serverUrl: "http://localhost:1234",
            password: "test-password",
          },
        },
      };
      await expect(
        callHandleAction({
          action: "react",
          params: { emoji: "❤️", messageId: "msg-123", chatGuid: "iMessage;-;+15551234567" },
          cfg,
          accountId: null,
        }),
      ).rejects.toThrow("requires Private API");
    });

    it("throws when messageId is missing", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          bluebubbles: {
            serverUrl: "http://localhost:1234",
            password: "test-password",
          },
        },
      };
      await expect(
        callHandleAction({
          action: "react",
          params: { emoji: "❤️" },
          cfg,
          accountId: null,
        }),
      ).rejects.toThrow("messageId");
    });

    it("throws when chatGuid cannot be resolved", async () => {
      vi.mocked(resolveChatGuidForTarget).mockResolvedValueOnce(null);

      const cfg: OpenClawConfig = {
        channels: {
          bluebubbles: {
            serverUrl: "http://localhost:1234",
            password: "test-password",
          },
        },
      };
      await expect(
        callHandleAction({
          action: "react",
          params: { emoji: "❤️", messageId: "msg-123", to: "+15551234567" },
          cfg,
          accountId: null,
        }),
      ).rejects.toThrow("chatGuid not found");
    });

    it("sends reaction successfully with chatGuid", async () => {
      const result = await runReactAction({
        emoji: "❤️",
        messageId: "msg-123",
        chatGuid: "iMessage;-;+15551234567",
      });

      expect(sendBlueBubblesReaction).toHaveBeenCalledWith(
        expect.objectContaining({
          chatGuid: "iMessage;-;+15551234567",
          messageGuid: "msg-123",
          emoji: "❤️",
        }),
      );
      // jsonResult returns { content: [...], details: payload }
      expect(result).toMatchObject({
        details: { ok: true, added: "❤️" },
      });
    });

    it("sends reaction removal successfully", async () => {
      const result = await runReactAction({
        emoji: "❤️",
        messageId: "msg-123",
        chatGuid: "iMessage;-;+15551234567",
        remove: true,
      });

      expect(sendBlueBubblesReaction).toHaveBeenCalledWith(
        expect.objectContaining({
          remove: true,
        }),
      );
      // jsonResult returns { content: [...], details: payload }
      expect(result).toMatchObject({
        details: { ok: true, removed: true },
      });
    });

    it("resolves chatGuid from to parameter", async () => {
      vi.mocked(resolveChatGuidForTarget).mockResolvedValueOnce("iMessage;-;+15559876543");

      const cfg: OpenClawConfig = {
        channels: {
          bluebubbles: {
            serverUrl: "http://localhost:1234",
            password: "test-password",
          },
        },
      };
      await callHandleAction({
        action: "react",
        params: {
          emoji: "👍",
          messageId: "msg-456",
          to: "+15559876543",
        },
        cfg,
        accountId: null,
      });

      expect(resolveChatGuidForTarget).toHaveBeenCalled();
      expect(sendBlueBubblesReaction).toHaveBeenCalledWith(
        expect.objectContaining({
          chatGuid: "iMessage;-;+15559876543",
        }),
      );
    });

    it("passes partIndex when provided", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          bluebubbles: {
            serverUrl: "http://localhost:1234",
            password: "test-password",
          },
        },
      };
      await callHandleAction({
        action: "react",
        params: {
          emoji: "😂",
          messageId: "msg-789",
          chatGuid: "iMessage;-;chat-guid",
          partIndex: 2,
        },
        cfg,
        accountId: null,
      });

      expect(sendBlueBubblesReaction).toHaveBeenCalledWith(
        expect.objectContaining({
          partIndex: 2,
        }),
      );
    });

    it("uses toolContext currentChannelId when no explicit target is provided", async () => {
      vi.mocked(resolveChatGuidForTarget).mockResolvedValueOnce("iMessage;-;+15550001111");

      const cfg: OpenClawConfig = {
        channels: {
          bluebubbles: {
            serverUrl: "http://localhost:1234",
            password: "test-password",
          },
        },
      };
      await callHandleAction({
        action: "react",
        params: {
          emoji: "👍",
          messageId: "msg-456",
        },
        cfg,
        accountId: null,
        toolContext: {
          currentChannelId: "bluebubbles:chat_guid:iMessage;-;+15550001111",
        },
      });

      expect(resolveChatGuidForTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { kind: "chat_guid", chatGuid: "iMessage;-;+15550001111" },
        }),
      );
      expect(sendBlueBubblesReaction).toHaveBeenCalledWith(
        expect.objectContaining({
          chatGuid: "iMessage;-;+15550001111",
        }),
      );
    });

    it("resolves short messageId before reacting", async () => {
      vi.mocked(resolveBlueBubblesMessageId).mockReturnValueOnce("resolved-uuid");

      const cfg: OpenClawConfig = {
        channels: {
          bluebubbles: {
            serverUrl: "http://localhost:1234",
            password: "test-password",
          },
        },
      };

      await callHandleAction({
        action: "react",
        params: {
          emoji: "❤️",
          messageId: "1",
          chatGuid: "iMessage;-;+15551234567",
        },
        cfg,
        accountId: null,
      });

      expect(resolveBlueBubblesMessageId).toHaveBeenCalledWith(
        "1",
        expect.objectContaining({
          requireKnownShortId: true,
          chatContext: expect.objectContaining({
            chatGuid: "iMessage;-;+15551234567",
          }),
        }),
      );
      expect(sendBlueBubblesReaction).toHaveBeenCalledWith(
        expect.objectContaining({
          messageGuid: "resolved-uuid",
        }),
      );
    });

    it("propagates short-id errors from the resolver", async () => {
      vi.mocked(resolveBlueBubblesMessageId).mockImplementationOnce(() => {
        throw new Error("short id expired");
      });

      const cfg: OpenClawConfig = {
        channels: {
          bluebubbles: {
            serverUrl: "http://localhost:1234",
            password: "test-password",
          },
        },
      };

      await expect(
        callHandleAction({
          action: "react",
          params: {
            emoji: "❤️",
            messageId: "999",
            chatGuid: "iMessage;-;+15551234567",
          },
          cfg,
          accountId: null,
        }),
      ).rejects.toThrow("short id expired");
    });

    it("accepts message param for edit action", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          bluebubbles: {
            serverUrl: "http://localhost:1234",
            password: "test-password",
          },
        },
      };

      await callHandleAction({
        action: "edit",
        params: { messageId: "msg-123", message: "updated" },
        cfg,
        accountId: null,
      });

      expect(editBlueBubblesMessage).toHaveBeenCalledWith(
        "msg-123",
        "updated",
        expect.objectContaining({ cfg, accountId: undefined }),
      );
    });

    it("accepts message/target aliases for sendWithEffect", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          bluebubbles: {
            serverUrl: "http://localhost:1234",
            password: "test-password",
          },
        },
      };

      const result = await callHandleAction({
        action: "sendWithEffect",
        params: {
          message: "peekaboo",
          target: "+15551234567",
          effect: "invisible ink",
        },
        cfg,
        accountId: null,
      });

      expect(sendMessageBlueBubbles).toHaveBeenCalledWith(
        "+15551234567",
        "peekaboo",
        expect.objectContaining({ effectId: "invisible ink" }),
      );
      expect(result).toMatchObject({
        details: { ok: true, messageId: "msg-123", effect: "invisible ink" },
      });
    });

    it("passes asVoice through sendAttachment", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          bluebubbles: {
            serverUrl: "http://localhost:1234",
            password: "test-password",
          },
        },
      };

      const base64Buffer = Buffer.from("voice").toString("base64");

      await callHandleAction({
        action: "sendAttachment",
        params: {
          to: "+15551234567",
          filename: "voice.mp3",
          buffer: base64Buffer,
          contentType: "audio/mpeg",
          asVoice: true,
        },
        cfg,
        accountId: null,
      });

      expect(sendBlueBubblesAttachment).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: "voice.mp3",
          contentType: "audio/mpeg",
          asVoice: true,
        }),
      );
    });

    it("throws when buffer is missing for setGroupIcon", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          bluebubbles: {
            serverUrl: "http://localhost:1234",
            password: "test-password",
          },
        },
      };

      await expect(
        callHandleAction({
          action: "setGroupIcon",
          params: { chatGuid: "iMessage;-;chat-guid" },
          cfg,
          accountId: null,
        }),
      ).rejects.toThrow(/requires an image/i);
    });

    it("sets group icon successfully with chatGuid and buffer", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          bluebubbles: {
            serverUrl: "http://localhost:1234",
            password: "test-password",
          },
        },
      };

      // Base64 encode a simple test buffer
      const testBuffer = Buffer.from("fake-image-data");
      const base64Buffer = testBuffer.toString("base64");

      const result = await callHandleAction({
        action: "setGroupIcon",
        params: {
          chatGuid: "iMessage;-;chat-guid",
          buffer: base64Buffer,
          filename: "group-icon.png",
          contentType: "image/png",
        },
        cfg,
        accountId: null,
      });

      expect(setGroupIconBlueBubbles).toHaveBeenCalledWith(
        "iMessage;-;chat-guid",
        expect.any(Uint8Array),
        "group-icon.png",
        expect.objectContaining({ contentType: "image/png" }),
      );
      expect(result).toMatchObject({
        details: { ok: true, chatGuid: "iMessage;-;chat-guid", iconSet: true },
      });
    });

    it("uses default filename when not provided for setGroupIcon", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          bluebubbles: {
            serverUrl: "http://localhost:1234",
            password: "test-password",
          },
        },
      };

      const base64Buffer = Buffer.from("test").toString("base64");

      await callHandleAction({
        action: "setGroupIcon",
        params: {
          chatGuid: "iMessage;-;chat-guid",
          buffer: base64Buffer,
        },
        cfg,
        accountId: null,
      });

      expect(setGroupIconBlueBubbles).toHaveBeenCalledWith(
        "iMessage;-;chat-guid",
        expect.any(Uint8Array),
        "icon.png",
        expect.anything(),
      );
    });
  });
});
