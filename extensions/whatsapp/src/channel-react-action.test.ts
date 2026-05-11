import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleWhatsAppReactAction } from "./channel-react-action.js";
import type { OpenClawConfig } from "./runtime-api.js";

const hoisted = vi.hoisted(() => ({
  handleWhatsAppAction: vi.fn(async () => ({ content: [{ type: "text", text: '{"ok":true}' }] })),
}));

vi.mock("./channel-react-action.runtime.js", async () => {
  return {
    handleWhatsAppAction: hoisted.handleWhatsAppAction,
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
      options?: { required?: boolean; allowEmpty?: boolean },
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
