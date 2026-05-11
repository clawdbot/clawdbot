import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage } from "baileys";
import { listMessageReceiptPlatformIds } from "openclaw/plugin-sdk/channel-message";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveWhatsAppOutboundMentions } from "./outbound-mentions.js";
import { createWebSendApi } from "./send-api.js";

const recordChannelActivity = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/channel-activity-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/channel-activity-runtime")
  >("openclaw/plugin-sdk/channel-activity-runtime");
  return {
    ...actual,
    recordChannelActivity: (...args: unknown[]) => recordChannelActivity(...args),
  };
});

describe("createWebSendApi", () => {
  const sendMessage = vi.fn(
    async (
      _jid: string,
      _content: AnyMessageContent,
      _options?: MiscMessageGenerationOptions,
    ): Promise<WAMessage | undefined> => ({ key: { id: "msg-1" } }) as WAMessage,
  );
  const sendPresenceUpdate = vi.fn(async () => {});
  let api: ReturnType<typeof createWebSendApi>;

  beforeEach(() => {
    vi.clearAllMocks();
    api = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate },
      defaultAccountId: "main",
    });
  });

  function requireRecord(value: unknown, label: string): Record<string, unknown> {
    expect(typeof value).toBe("object");
    expect(value).not.toBeNull();
    if (typeof value !== "object" || value === null) {
      throw new Error(`${label} was not an object`);
    }
    return value as Record<string, unknown>;
  }

  function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
    for (const [key, value] of Object.entries(fields)) {
      expect(record[key]).toEqual(value);
    }
  }

  function requireSendContent(callIndex = 0): Record<string, unknown> {
    return requireRecord(sendMessage.mock.calls[callIndex]?.[1], "sent message content");
  }

  function requireSendOptions(callIndex = 0): Record<string, unknown> {
    return requireRecord(sendMessage.mock.calls[callIndex]?.[2], "sent message options");
  }

  function expectSendContentFields(callIndex: number, fields: Record<string, unknown>) {
    expectRecordFields(requireSendContent(callIndex), fields);
  }

  function expectSendResultFields(
    result: Awaited<ReturnType<typeof api.sendMessage | typeof api.sendReaction>>,
    fields: Record<string, unknown>,
  ) {
    expectRecordFields(requireRecord(result, "send result"), fields);
  }

  it("uses sendOptions fileName for outbound documents", async () => {
    const payload = Buffer.from("pdf");
    await api.sendMessage("+1555", "doc", payload, "application/pdf", { fileName: "invoice.pdf" });
    expect(sendMessage.mock.calls[0]?.[0]).toBe("1555@s.whatsapp.net");
    expectSendContentFields(0, {
      document: payload,
      fileName: "invoice.pdf",
      caption: "doc",
      mimetype: "application/pdf",
    });
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "main",
      direction: "outbound",
    });
  });

  it("falls back to default document filename when fileName is absent", async () => {
    const payload = Buffer.from("pdf");
    await api.sendMessage("+1555", "doc", payload, "application/pdf");
    expect(sendMessage.mock.calls[0]?.[0]).toBe("1555@s.whatsapp.net");
    expectSendContentFields(0, {
      document: payload,
      fileName: "file",
      caption: "doc",
      mimetype: "application/pdf",
    });
  });

  it("sends plain text messages", async () => {
    const res = await api.sendMessage("+1555", "hello");
    expect(sendMessage).toHaveBeenCalledWith("1555@s.whatsapp.net", { text: "hello" });
    expectSendResultFields(res, {
      kind: "text",
      messageId: "msg-1",
      providerAccepted: true,
    });
    expect(res.receipt ? listMessageReceiptPlatformIds(res.receipt) : []).toEqual(["msg-1"]);
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "main",
      direction: "outbound",
    });
  });

  it("adds native mention metadata to group text sends", async () => {
    api = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate },
      defaultAccountId: "main",
      resolveOutboundMentions: ({ jid, text }) =>
        resolveWhatsAppOutboundMentions({
          chatJid: jid,
          text,
          participants: [
            {
              id: "277038292303944:4@lid",
              phoneNumber: "5511976136970@s.whatsapp.net",
            },
          ],
        }),
    });

    await api.sendMessage("120363000000000000@g.us", "ping @+5511976136970");

    expect(sendMessage).toHaveBeenCalledWith("120363000000000000@g.us", {
      text: "ping @277038292303944",
      mentions: ["277038292303944@lid"],
    });
  });

  it("supports image media with caption", async () => {
    const payload = Buffer.from("img");
    await api.sendMessage("+1555", "cap", payload, "image/jpeg");
    expect(sendMessage.mock.calls[0]?.[0]).toBe("1555@s.whatsapp.net");
    expectSendContentFields(0, {
      image: payload,
      caption: "cap",
      mimetype: "image/jpeg",
    });
  });

  it("adds native mention metadata to group media captions", async () => {
    api = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate },
      defaultAccountId: "main",
      resolveOutboundMentions: ({ jid, text }) =>
        resolveWhatsAppOutboundMentions({
          chatJid: jid,
          text,
          participants: [{ id: "15551234567@s.whatsapp.net" }],
        }),
    });
    const payload = Buffer.from("img");

    await api.sendMessage("120363000000000000@g.us", "cap @15551234567", payload, "image/jpeg");

    expect(sendMessage.mock.calls[0]?.[0]).toBe("120363000000000000@g.us");
    expectSendContentFields(0, {
      image: payload,
      caption: "cap @15551234567",
      mimetype: "image/jpeg",
      mentions: ["15551234567@s.whatsapp.net"],
    });
  });

  it("supports audio as push-to-talk voice note", async () => {
    const payload = Buffer.from("aud");
    await api.sendMessage("+1555", "", payload, "audio/ogg", { accountId: "alt" });
    expect(sendMessage.mock.calls[0]?.[0]).toBe("1555@s.whatsapp.net");
    expectSendContentFields(0, {
      audio: payload,
      ptt: true,
      mimetype: "audio/ogg",
    });
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "alt",
      direction: "outbound",
    });
  });

  it("sends visible text separately from push-to-talk voice notes", async () => {
    const payload = Buffer.from("aud");
    sendMessage
      .mockResolvedValueOnce({ key: { id: "voice-1" } })
      .mockResolvedValueOnce({ key: { id: "voice-text-1" } });
    const res = await api.sendMessage("+1555", "voice text", payload, "audio/ogg");
    expect(sendMessage.mock.calls[0]?.[0]).toBe("1555@s.whatsapp.net");
    expectSendContentFields(0, {
      audio: payload,
      ptt: true,
      mimetype: "audio/ogg",
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, "1555@s.whatsapp.net", {
      text: "voice text",
    });
    expectSendResultFields(res, {
      kind: "media",
      messageId: "voice-1",
      providerAccepted: true,
    });
    expect(res.receipt ? listMessageReceiptPlatformIds(res.receipt) : []).toEqual([
      "voice-1",
      "voice-text-1",
    ]);
  });

  it("supports video media and gifPlayback option", async () => {
    const payload = Buffer.from("vid");
    await api.sendMessage("+1555", "cap", payload, "video/mp4", { gifPlayback: true });
    expect(sendMessage.mock.calls[0]?.[0]).toBe("1555@s.whatsapp.net");
    expectSendContentFields(0, {
      video: payload,
      caption: "cap",
      mimetype: "video/mp4",
      gifPlayback: true,
    });
  });

  it("falls back to unknown messageId if Baileys result does not expose key.id", async () => {
    sendMessage.mockResolvedValueOnce({ key: {} as { id: string } });
    const res = await api.sendMessage("+1555", "hello");
    expect(res.messageId).toBe("unknown");
  });

  it("sends polls and records outbound activity", async () => {
    const res = await api.sendPoll("+1555", {
      question: "Q?",
      options: ["a", "b"],
      maxSelections: 2,
    });
    expect(sendMessage.mock.calls[0]?.[0]).toBe("1555@s.whatsapp.net");
    expect(requireSendContent().poll).toEqual({
      name: "Q?",
      values: ["a", "b"],
      selectableCount: 2,
    });
    expect(res.messageId).toBe("msg-1");
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "main",
      direction: "outbound",
    });
  });

  it("sends reactions with participant JID normalization", async () => {
    const res = await api.sendReaction("+1555", "msg-2", "👍", false, "+1999");
    expect(sendMessage.mock.calls[0]?.[0]).toBe("1555@s.whatsapp.net");
    const react = requireRecord(requireSendContent().react, "reaction content");
    expect(react.text).toBe("👍");
    expectRecordFields(requireRecord(react.key, "reaction key"), {
      remoteJid: "1555@s.whatsapp.net",
      id: "msg-2",
      fromMe: false,
      participant: "1999@s.whatsapp.net",
    });
    expectSendResultFields(res, {
      kind: "reaction",
      messageId: "msg-1",
      providerAccepted: true,
    });
  });

  it("reports provider-unaccepted sends when Baileys returns no message", async () => {
    sendMessage.mockResolvedValueOnce(undefined);

    const res = await api.sendMessage("+1555", "hello");

    expectSendResultFields(res, {
      kind: "text",
      messageId: "unknown",
      providerAccepted: false,
    });
    expect(res.receipt ? listMessageReceiptPlatformIds(res.receipt) : []).toStrictEqual([]);
  });

  it("keeps direct-chat reactions without a participant key", async () => {
    await api.sendReaction("+1555", "msg-2", "👍", false);
    expect(sendMessage.mock.calls[0]?.[0]).toBe("1555@s.whatsapp.net");
    const react = requireRecord(requireSendContent().react, "reaction content");
    expect(react.text).toBe("👍");
    expectRecordFields(requireRecord(react.key, "reaction key"), {
      remoteJid: "1555@s.whatsapp.net",
      id: "msg-2",
      fromMe: false,
      participant: undefined,
    });
  });

  it("preserves LID participants in reaction keys", async () => {
    await api.sendReaction("12345@g.us", "msg-2", "👍", false, "123@lid");
    expect(sendMessage.mock.calls[0]?.[0]).toBe("12345@g.us");
    const react = requireRecord(requireSendContent().react, "reaction content");
    expect(react.text).toBe("👍");
    expectRecordFields(requireRecord(react.key, "reaction key"), {
      remoteJid: "12345@g.us",
      id: "msg-2",
      fromMe: false,
      participant: "123@lid",
    });
  });

  it("sends composing presence updates to the recipient JID", async () => {
    await api.sendComposingTo("+1555");
    expect(sendPresenceUpdate).toHaveBeenCalledWith("composing", "1555@s.whatsapp.net");
  });

  it("does not send composing presence to newsletter JIDs", async () => {
    await api.sendComposingTo("120363401234567890@newsletter");
    expect(sendPresenceUpdate).not.toHaveBeenCalled();
  });

  it("preserves newsletter JIDs for outbound sends", async () => {
    await api.sendMessage("120363401234567890@newsletter", "hello");
    expect(sendMessage).toHaveBeenCalledWith("120363401234567890@newsletter", {
      text: "hello",
    });
  });

  it("sends media as document when mediaType is undefined", async () => {
    const mediaBuffer = Buffer.from("test");

    await api.sendMessage("123", "hello", mediaBuffer, undefined);

    expect(sendMessage.mock.calls[0]?.[0]).toBe("123@s.whatsapp.net");
    expectSendContentFields(0, {
      document: mediaBuffer,
      mimetype: "application/octet-stream",
    });
  });

  it("does not set mediaType when mediaBuffer is absent", async () => {
    await api.sendMessage("123", "hello");

    expect(sendMessage).toHaveBeenCalledWith("123@s.whatsapp.net", { text: "hello" });
  });

  it("preserves the quoted remoteJid provided by the outbound adapter", async () => {
    await api.sendMessage("+1555", "hello", undefined, undefined, {
      quotedMessageKey: {
        id: "quoted-1",
        remoteJid: "277038292303944@lid",
        fromMe: false,
        participant: "1234@s.whatsapp.net",
        messageText: "quoted body",
      },
    });

    expect(sendMessage.mock.calls[0]?.[0]).toBe("1555@s.whatsapp.net");
    expect(sendMessage.mock.calls[0]?.[1]).toEqual({ text: "hello" });
    const quoted = requireRecord(requireSendOptions().quoted, "quoted message");
    expectRecordFields(requireRecord(quoted.key, "quoted key"), {
      remoteJid: "277038292303944@lid",
      id: "quoted-1",
    });
  });
});

// Integration tests for issue #67378: createWebSendApi must route outbound
// PN-only sends through the LID forward-mapping when authDir is provided,
// otherwise messages going to LID-addressed contacts vanish into a
// sender-only ghost chat.
describe("createWebSendApi LID resolution (issue #67378)", () => {
  const sendMessage = vi.fn(
    async (
      _jid: string,
      _content: AnyMessageContent,
      _options?: MiscMessageGenerationOptions,
    ): Promise<WAMessage | undefined> => ({ key: { id: "msg-1" } }) as WAMessage,
  );
  const sendPresenceUpdate = vi.fn(async () => {});
  let authDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    authDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wa-lid-"));
    fs.writeFileSync(path.join(authDir, "lid-mapping-15555550000.json"), JSON.stringify("987654"));
  });

  afterEach(() => {
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  it("resolves PN to LID for sendMessage when authDir is provided", async () => {
    const api = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate },
      defaultAccountId: "main",
      authDir,
    });
    await api.sendMessage("+15555550000", "hello");
    expect(sendMessage).toHaveBeenCalledWith("987654@lid", { text: "hello" });
  });

  it("falls back to PN s.whatsapp.net when no LID mapping exists", async () => {
    const api = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate },
      defaultAccountId: "main",
      authDir,
    });
    await api.sendMessage("+33123456789", "hello");
    expect(sendMessage).toHaveBeenCalledWith("33123456789@s.whatsapp.net", { text: "hello" });
  });

  it("resolves PN to LID for sendPoll", async () => {
    const api = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate },
      defaultAccountId: "main",
      authDir,
    });
    await api.sendPoll("+15555550000", { question: "Q?", options: ["a", "b"] });
    expect(sendMessage.mock.calls[0]?.[0]).toBe("987654@lid");
    expect(typeof sendMessage.mock.calls[0]?.[1]).toBe("object");
    expect(sendMessage.mock.calls[0]?.[1]).not.toBeNull();
    expect("poll" in (sendMessage.mock.calls[0]?.[1] as Record<string, unknown>)).toBe(true);
  });

  it("resolves PN to LID for sendComposingTo presence", async () => {
    const api = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate },
      defaultAccountId: "main",
      authDir,
    });
    await api.sendComposingTo("+15555550000");
    expect(sendPresenceUpdate).toHaveBeenCalledWith("composing", "987654@lid");
  });

  it("skips newsletter composing presence when authDir is provided", async () => {
    const api = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate },
      defaultAccountId: "main",
      authDir,
    });
    await api.sendComposingTo("120363401234567890@newsletter");
    expect(sendPresenceUpdate).not.toHaveBeenCalled();
  });

  it("preserves legacy behavior (no authDir → PN-only routing)", async () => {
    const api = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate },
      defaultAccountId: "main",
      // authDir intentionally omitted
    });
    await api.sendMessage("+15555550000", "hello");
    expect(sendMessage).toHaveBeenCalledWith("15555550000@s.whatsapp.net", { text: "hello" });
  });
});
