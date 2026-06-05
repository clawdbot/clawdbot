// Whatsapp tests cover channel react action plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleWhatsAppReactAction } from "./channel-react-action.js";
import type { OpenClawConfig } from "./runtime-api.js";

const hoisted = vi.hoisted(() => ({
  handleWhatsAppAction: vi.fn(async () => ({ content: [{ type: "text", text: '{"ok":true}' }] })),
  resolveAuthorizedWhatsAppOutboundTarget: vi.fn(
    ({
      chatJid,
      accountId,
    }: {
      chatJid: string;
      accountId?: string;
    }): { to: string; accountId: string } => ({
      to: chatJid,
      accountId: accountId ?? "default",
    }),
  ),
  resolveWhatsAppAccount: vi.fn(() => ({ accountId: "default", mediaMaxMb: 50 })),
  resolveWhatsAppMediaMaxBytes: vi.fn(() => 50 * 1024 * 1024),
  sendMessageWhatsApp: vi.fn(async () => ({
    messageId: "msg-media-1",
    toJid: "1555@s.whatsapp.net",
  })),
}));

vi.mock("./channel-react-action.runtime.js", async () => {
  return {
    handleWhatsAppAction: hoisted.handleWhatsAppAction,
    resolveAuthorizedWhatsAppOutboundTarget: hoisted.resolveAuthorizedWhatsAppOutboundTarget,
    resolveWhatsAppAccount: hoisted.resolveWhatsAppAccount,
    resolveWhatsAppMediaMaxBytes: hoisted.resolveWhatsAppMediaMaxBytes,
    sendMessageWhatsApp: hoisted.sendMessageWhatsApp,
    resolveReactionMessageId: ({
      args,
      toolContext,
    }: {
      args: Record<string, unknown>;
      toolContext?: { currentMessageId?: string | number | null };
    }) => args.messageId ?? toolContext?.currentMessageId ?? null,
    readStringOrNumberParam: (params: Record<string, unknown>, key: string) => {
      const value = params[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === "string" && value.trim()) {
        return value;
      }
      return undefined;
    },
    isWhatsAppGroupJid: (value?: string | null) => (value ?? "").trim().endsWith("@g.us"),
    normalizeWhatsAppTarget: (value?: string | null) => {
      const raw = (value ?? "").trim();
      if (!raw) {
        return null;
      }
      const stripped = raw.replace(/^whatsapp:/, "");
      if (stripped.endsWith("@g.us")) {
        return stripped;
      }
      return stripped.startsWith("+") ? stripped : `+${stripped.replace(/^\+/, "")}`;
    },
    readStringParam: (
      params: Record<string, unknown>,
      key: string,
      options?: { required?: boolean; allowEmpty?: boolean; trim?: boolean },
    ) => {
      const value = params[key];
      if (value == null) {
        if (options?.required) {
          const err = new Error(`${key} required`);
          err.name = "ToolInputError";
          throw err;
        }
        return undefined;
      }
      const text = typeof value === "string" ? value : "";
      if (!options?.allowEmpty && !text.trim()) {
        if (options?.required) {
          const err = new Error(`${key} required`);
          err.name = "ToolInputError";
          throw err;
        }
        return undefined;
      }
      return text;
    },
  };
});

describe("whatsapp react action messageId resolution", () => {
  const baseCfg = {
    channels: { whatsapp: { actions: { reactions: true }, allowFrom: ["*"] } },
  } as OpenClawConfig;

  beforeEach(() => {
    hoisted.handleWhatsAppAction.mockClear();
    hoisted.resolveAuthorizedWhatsAppOutboundTarget.mockClear();
    hoisted.resolveWhatsAppAccount.mockClear();
    hoisted.resolveWhatsAppMediaMaxBytes.mockClear();
    hoisted.resolveWhatsAppAccount.mockReturnValue({ accountId: "default", mediaMaxMb: 50 });
    hoisted.resolveWhatsAppMediaMaxBytes.mockReturnValue(50 * 1024 * 1024);
    hoisted.sendMessageWhatsApp.mockClear();
  });

  it("sends upload-file through the WhatsApp media send path", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("media"));

    const result = await handleWhatsAppReactAction({
      action: "upload-file",
      params: {
        to: "+1555",
        filePath: "/tmp/pic.png",
        caption: "picture caption",
        forceDocument: "true",
        gifPlayback: true,
        asVoice: "true",
      },
      cfg: baseCfg,
      accountId: "default",
      mediaLocalRoots: ["/tmp"],
      mediaReadFile,
    });

    expect(hoisted.resolveAuthorizedWhatsAppOutboundTarget).toHaveBeenCalledWith({
      cfg: baseCfg,
      chatJid: "+1555",
      accountId: "default",
      actionLabel: "upload-file",
    });
    expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledWith("+1555", "picture caption", {
      verbose: false,
      cfg: baseCfg,
      mediaUrl: "/tmp/pic.png",
      mediaAccess: undefined,
      mediaLocalRoots: ["/tmp"],
      mediaReadFile,
      gifPlayback: true,
      audioAsVoice: true,
      forceDocument: true,
      accountId: "default",
    });
    expect(result.details).toMatchObject({
      ok: true,
      channel: "whatsapp",
      action: "upload-file",
      messageId: "msg-media-1",
      toJid: "1555@s.whatsapp.net",
    });
  });

  it("does not send upload-file when target authorization fails", async () => {
    hoisted.resolveAuthorizedWhatsAppOutboundTarget.mockImplementationOnce(() => {
      throw new Error("WhatsApp upload-file blocked");
    });

    await expect(
      handleWhatsAppReactAction({
        action: "upload-file",
        params: {
          to: "+1555",
          filePath: "/tmp/pic.png",
        },
        cfg: baseCfg,
        accountId: "default",
      }),
    ).rejects.toThrow("WhatsApp upload-file blocked");
    expect(hoisted.sendMessageWhatsApp).not.toHaveBeenCalled();
  });

  it("sends upload-file from the hydrated buffer payload", async () => {
    await handleWhatsAppReactAction({
      action: "upload-file",
      params: {
        to: "+1555",
        buffer: Buffer.from("hello").toString("base64"),
        contentType: "text/plain",
        filename: "hello.txt",
        filePath: "/tmp/hello.txt",
        forceDocument: true,
        message: "file caption",
      },
      cfg: baseCfg,
      accountId: "default",
    });

    expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledWith("+1555", "file caption", {
      verbose: false,
      cfg: baseCfg,
      mediaPayload: {
        buffer: Buffer.from("hello"),
        contentType: "text/plain",
        fileName: "hello.txt",
      },
      mediaAccess: undefined,
      mediaLocalRoots: undefined,
      mediaReadFile: undefined,
      gifPlayback: undefined,
      audioAsVoice: undefined,
      forceDocument: true,
      accountId: "default",
    });
  });

  it("rejects upload-file buffers above the WhatsApp media limit", async () => {
    hoisted.resolveWhatsAppMediaMaxBytes.mockReturnValueOnce(4);

    await expect(
      handleWhatsAppReactAction({
        action: "upload-file",
        params: {
          to: "+1555",
          buffer: Buffer.from("hello").toString("base64"),
          contentType: "text/plain",
          filename: "hello.txt",
        },
        cfg: baseCfg,
        accountId: "default",
      }),
    ).rejects.toThrow("WhatsApp upload-file buffer exceeds configured media limit");
    expect(hoisted.sendMessageWhatsApp).not.toHaveBeenCalled();
  });

  it("requires upload-file media path input", async () => {
    await expect(
      handleWhatsAppReactAction({
        action: "upload-file",
        params: {
          to: "+1555",
          caption: "missing media",
        },
        cfg: baseCfg,
        accountId: "default",
      }),
    ).rejects.toThrow("WhatsApp upload-file requires media");
    expect(hoisted.sendMessageWhatsApp).not.toHaveBeenCalled();
  });

  it("uses explicit messageId when provided", async () => {
    await handleWhatsAppReactAction({
      action: "react",
      params: { messageId: "explicit-id", emoji: "👍", to: "+1555" },
      cfg: baseCfg,
      accountId: "default",
    });
    expect(hoisted.handleWhatsAppAction).toHaveBeenCalledWith(
      {
        action: "react",
        chatJid: "+1555",
        messageId: "explicit-id",
        emoji: "👍",
        remove: undefined,
        participant: undefined,
        accountId: "default",
        fromMe: undefined,
      },
      baseCfg,
    );
  });

  it("falls back to toolContext.currentMessageId when messageId omitted", async () => {
    await handleWhatsAppReactAction({
      action: "react",
      params: { emoji: "❤️", to: "+1555" },
      cfg: baseCfg,
      accountId: "default",
      toolContext: {
        currentChannelId: "whatsapp:+1555",
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    });
    expect(hoisted.handleWhatsAppAction).toHaveBeenCalledWith(
      {
        action: "react",
        chatJid: "+1555",
        messageId: "ctx-msg-42",
        emoji: "❤️",
        remove: undefined,
        participant: undefined,
        accountId: "default",
        fromMe: undefined,
      },
      baseCfg,
    );
  });

  it("converts numeric toolContext messageId to string", async () => {
    await handleWhatsAppReactAction({
      action: "react",
      params: { emoji: "🎉", to: "+1555" },
      cfg: baseCfg,
      accountId: "default",
      toolContext: {
        currentChannelId: "whatsapp:+1555",
        currentChannelProvider: "whatsapp",
        currentMessageId: 12345,
      },
    });
    expect(hoisted.handleWhatsAppAction).toHaveBeenCalledWith(
      {
        action: "react",
        chatJid: "+1555",
        messageId: "12345",
        emoji: "🎉",
        remove: undefined,
        participant: undefined,
        accountId: "default",
        fromMe: undefined,
      },
      baseCfg,
    );
  });

  it("throws ToolInputError when messageId missing and no toolContext", async () => {
    const err = await handleWhatsAppReactAction({
      action: "react",
      params: { emoji: "👍", to: "+1555" },
      cfg: baseCfg,
      accountId: "default",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("ToolInputError");
  });

  it("skips context fallback when targeting a different chat", async () => {
    const err = await handleWhatsAppReactAction({
      action: "react",
      params: { emoji: "👍", to: "+9999" },
      cfg: baseCfg,
      accountId: "default",
      toolContext: {
        currentChannelId: "whatsapp:+1555",
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("ToolInputError");
  });

  it("uses context fallback when target matches current chat", async () => {
    await handleWhatsAppReactAction({
      action: "react",
      params: { emoji: "👍", to: "12345@g.us" },
      cfg: baseCfg,
      accountId: "default",
      requesterSenderId: "123@lid",
      toolContext: {
        currentChannelId: "whatsapp:12345@g.us",
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    });
    expect(hoisted.handleWhatsAppAction).toHaveBeenCalledWith(
      {
        action: "react",
        chatJid: "12345@g.us",
        messageId: "ctx-msg-42",
        emoji: "👍",
        remove: undefined,
        participant: "123@lid",
        accountId: "default",
        fromMe: undefined,
      },
      baseCfg,
    );
  });

  it("keeps direct-chat reactions without an inferred participant", async () => {
    await handleWhatsAppReactAction({
      action: "react",
      params: { emoji: "👍", to: "+1555" },
      cfg: baseCfg,
      accountId: "default",
      requesterSenderId: "123@lid",
      toolContext: {
        currentChannelId: "whatsapp:+1555",
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    });
    expect(hoisted.handleWhatsAppAction).toHaveBeenCalledWith(
      {
        action: "react",
        chatJid: "+1555",
        messageId: "ctx-msg-42",
        emoji: "👍",
        remove: undefined,
        participant: undefined,
        accountId: "default",
        fromMe: undefined,
      },
      baseCfg,
    );
  });

  it("prefers explicit participant over inferred current-message participant", async () => {
    await handleWhatsAppReactAction({
      action: "react",
      params: {
        emoji: "👍",
        to: "12345@g.us",
        participant: "555@s.whatsapp.net",
      },
      cfg: baseCfg,
      accountId: "default",
      requesterSenderId: "123@lid",
      toolContext: {
        currentChannelId: "whatsapp:12345@g.us",
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    });
    expect(hoisted.handleWhatsAppAction).toHaveBeenCalledWith(
      {
        action: "react",
        chatJid: "12345@g.us",
        messageId: "ctx-msg-42",
        emoji: "👍",
        remove: undefined,
        participant: "555@s.whatsapp.net",
        accountId: "default",
        fromMe: undefined,
      },
      baseCfg,
    );
  });

  it("does not reuse the current-chat participant for cross-chat reactions", async () => {
    const err = await handleWhatsAppReactAction({
      action: "react",
      params: { emoji: "👍", to: "99999@g.us" },
      cfg: baseCfg,
      accountId: "default",
      requesterSenderId: "123@lid",
      toolContext: {
        currentChannelId: "whatsapp:12345@g.us",
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("ToolInputError");
    expect(hoisted.handleWhatsAppAction).not.toHaveBeenCalled();
  });

  it("does not infer participant when messageId is explicitly provided", async () => {
    await handleWhatsAppReactAction({
      action: "react",
      params: { emoji: "👍", to: "12345@g.us", messageId: "older-msg-7" },
      cfg: baseCfg,
      accountId: "default",
      requesterSenderId: "123@lid",
      toolContext: {
        currentChannelId: "whatsapp:12345@g.us",
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    });
    expect(hoisted.handleWhatsAppAction).toHaveBeenCalledWith(
      {
        action: "react",
        chatJid: "12345@g.us",
        messageId: "older-msg-7",
        emoji: "👍",
        remove: undefined,
        participant: undefined,
        accountId: "default",
        fromMe: undefined,
      },
      baseCfg,
    );
  });

  it("skips context fallback when source is another provider", async () => {
    const err = await handleWhatsAppReactAction({
      action: "react",
      params: { emoji: "👍", to: "+1555" },
      cfg: baseCfg,
      accountId: "default",
      toolContext: {
        currentChannelId: "telegram:-1003841603622",
        currentChannelProvider: "telegram",
        currentMessageId: "tg-msg-99",
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("ToolInputError");
  });

  it("skips context fallback when currentChannelId is missing with explicit target", async () => {
    const err = await handleWhatsAppReactAction({
      action: "react",
      params: { emoji: "👍", to: "+1555" },
      cfg: baseCfg,
      accountId: "default",
      toolContext: {
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("ToolInputError");
  });
});
