// WhatsApp monitor inbox behavior split by ownership.
import fsSync from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  imageOps,
  nextMessageId,
  inboundMessage,
  installStreamsInboundMessageHooks,
} from "./monitor-inbox.streams-inbound-messages.test-support.js";
import {
  buildNotifyMessageUpsert,
  getAuthDir,
  startInboxMonitor,
  waitForMessageCalls,
  type InboxOnMessage,
} from "./monitor-inbox.test-harness.js";

describe("web monitor inbox reply context", () => {
  installStreamsInboundMessageHooks();

  async function expectQuotedReplyContext(quotedMessage: unknown) {
    const onMessage = vi.fn(async (msg) => {
      await msg.platform.reply("pong");
    });

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const upsert = {
      type: "notify",
      messages: [
        {
          key: {
            id: nextMessageId("quoted"),
            fromMe: false,
            remoteJid: "999@s.whatsapp.net",
          },
          message: {
            extendedTextMessage: {
              text: "reply",
              contextInfo: {
                stanzaId: "q1",
                participant: "111@s.whatsapp.net",
                quotedMessage,
              },
            },
          },
          messageTimestamp: 1_700_000_000,
          pushName: "Tester",
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);

    const inbound = inboundMessage(onMessage);
    expect(inbound.quote?.id).toBe("q1");
    expect(inbound.quote?.body).toBe("original");
    expect(inbound.quote?.sender?.displayName).toBe("+111");
    const sender = inbound.platform.sender as { e164?: string; name?: string };
    expect(sender.e164).toBe("+999");
    expect(sender.name).toBe("Tester");
    const replyTo = inbound.quote?.context as {
      body?: string;
      id?: string;
      sender?: { e164?: string; jid?: string; label?: string };
    };
    expect(replyTo.id).toBe("q1");
    expect(replyTo.body).toBe("original");
    expect(replyTo.sender?.jid).toBe("111@s.whatsapp.net");
    expect(replyTo.sender?.e164).toBe("+111");
    expect(replyTo.sender?.label).toBe("+111");
    const self = inbound.platform.self as { e164?: string; jid?: string };
    expect(self.jid).toBe("123@s.whatsapp.net");
    expect(self.e164).toBe("+123");
    expect(sock.sendMessage).toHaveBeenCalledWith("999@s.whatsapp.net", {
      text: "pong",
    });

    await listener.close();
  }

  it("prepopulates image previews for inbound sendMedia replies", async () => {
    const onMessage = vi.fn(async () => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: nextMessageId("image-preview"),
        remoteJid: "999@s.whatsapp.net",
        text: "ping",
        timestamp: 1_700_000_000,
        pushName: "Tester",
      }),
    );
    await waitForMessageCalls(onMessage, 1);

    const inbound = inboundMessage(onMessage);
    const image = Buffer.from("img");
    const thumbnail = Buffer.from("thumb");
    imageOps.getImageMetadata.mockResolvedValueOnce({ width: 640, height: 480 });
    imageOps.resizeToJpeg.mockResolvedValueOnce(thumbnail);

    await inbound.platform.sendMedia({ image, caption: "cap", mimetype: "image/png" });

    expect(imageOps.resizeToJpeg).toHaveBeenCalledWith({
      buffer: image,
      maxSide: 32,
      quality: 50,
      withoutEnlargement: true,
    });
    expect(sock.sendMessage).toHaveBeenCalledWith("999@s.whatsapp.net", {
      image,
      caption: "cap",
      mimetype: "image/png",
      width: 640,
      height: 480,
      jpegThumbnail: thumbnail.toString("base64"),
    });

    await listener.close();
  });

  it("resolves LID JIDs using Baileys LID mapping store", async () => {
    const onMessage = vi.fn(async () => {});

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const getPNForLID = vi.spyOn(sock.signalRepository.lidMapping, "getPNForLID");
    sock.signalRepository.lidMapping.getPNForLID.mockResolvedValueOnce("999:0@s.whatsapp.net");
    const upsert = buildNotifyMessageUpsert({
      id: nextMessageId("lid-store"),
      remoteJid: "999@lid",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);

    expect(getPNForLID).toHaveBeenCalledWith("999@lid");
    expect(getPNForLID).toHaveBeenCalledTimes(1);
    const inbound = inboundMessage(onMessage);
    expect(inbound.payload.body).toBe("ping");
    expect(inbound.admission?.conversation.id).toBe("+999");
    expect(inbound.platform.recipientJid).toBe("+123");

    await listener.close();
  });

  it("resolves LID JIDs via authDir mapping files", async () => {
    const onMessage = vi.fn(async () => {});
    fsSync.writeFileSync(
      path.join(getAuthDir(), "lid-mapping-555_reverse.json"),
      JSON.stringify("1555"),
    );

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const getPNForLID = vi.spyOn(sock.signalRepository.lidMapping, "getPNForLID");
    const upsert = buildNotifyMessageUpsert({
      id: nextMessageId("lid-authdir"),
      remoteJid: "555@lid",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);

    const inbound = inboundMessage(onMessage);
    expect(inbound.payload.body).toBe("ping");
    expect(inbound.admission?.conversation.id).toBe("+1555");
    expect(inbound.platform.recipientJid).toBe("+123");
    expect(getPNForLID).not.toHaveBeenCalled();

    await listener.close();
  });

  it("delivers LID-addressed DMs from the envelope phone JID when no mapping exists", async () => {
    const onMessage = vi.fn(async () => {});

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const getPNForLID = vi.spyOn(sock.signalRepository.lidMapping, "getPNForLID");
    const upsert = buildNotifyMessageUpsert({
      id: nextMessageId("lid-envelope-dm"),
      remoteJid: "777@lid",
      remoteJidAlt: "1777@s.whatsapp.net",
      addressingMode: "lid",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);

    expect(getPNForLID).toHaveBeenCalledWith("777@lid");
    const inbound = inboundMessage(onMessage);
    expect(inbound.payload.body).toBe("ping");
    expect(inbound.admission?.conversation.id).toBe("+1777");
    expect(inbound.admission?.conversation.kind).toBe("direct");

    await listener.close();
  });

  it("resolves group participant identity from the envelope phone JID when no mapping exists", async () => {
    const onMessage = vi.fn(async () => {});

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const upsert = buildNotifyMessageUpsert({
      id: nextMessageId("lid-envelope-group"),
      remoteJid: "123@g.us",
      participant: "888@lid",
      participantAlt: "1888@s.whatsapp.net",
      addressingMode: "lid",
      text: "ping",
      timestamp: 1_700_000_000,
    });

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);

    const inbound = inboundMessage(onMessage);
    expect(inbound.payload.body).toBe("ping");
    expect(inbound.platform.senderE164).toBe("+1888");
    expect(inbound.admission?.conversation.id).toBe("123@g.us");

    await listener.close();
  });

  it("resolves group participant LID JIDs via Baileys mapping", async () => {
    const onMessage = vi.fn(async () => {});

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const getPNForLID = vi.spyOn(sock.signalRepository.lidMapping, "getPNForLID");
    sock.signalRepository.lidMapping.getPNForLID.mockResolvedValueOnce("444:0@s.whatsapp.net");
    const upsert = buildNotifyMessageUpsert({
      id: nextMessageId("group-lid"),
      remoteJid: "123@g.us",
      participant: "444@lid",
      text: "ping",
      timestamp: 1_700_000_000,
    });

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);

    expect(getPNForLID).toHaveBeenCalledWith("444@lid");
    const inbound = inboundMessage(onMessage);
    expect(inbound.payload.body).toBe("ping");
    expect(inbound.admission?.conversation.id).toBe("123@g.us");
    expect(inbound.platform.senderE164).toBe("+444");
    expect(inbound.admission?.conversation.kind).toBe("group");

    await listener.close();
  });

  it("captures reply context from quoted messages", async () => {
    await expectQuotedReplyContext({ conversation: "original" });
  });

  it("preserves native reply context when WhatsApp omits the quoted message", async () => {
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);

    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: {
            id: nextMessageId("quoted-unavailable"),
            fromMe: false,
            remoteJid: "999@s.whatsapp.net",
          },
          message: {
            extendedTextMessage: {
              text: "yes",
              contextInfo: {
                stanzaId: "original-message",
                participant: "111@s.whatsapp.net",
              },
            },
          },
          messageTimestamp: 1_700_000_000,
          pushName: "Tester",
        },
      ],
    });

    await waitForMessageCalls(onMessage, 1);

    const inbound = inboundMessage(onMessage);
    expect(inbound.payload.body).toBe("yes");
    expect(inbound.quote).toMatchObject({
      id: "original-message",
      body: "[quoted message unavailable]",
      sender: { displayName: "+111", jid: "111@s.whatsapp.net", e164: "+111" },
    });

    await listener.close();
  });

  it.each([
    ["captures reply context from wrapped quoted messages", "viewOnceMessageV2Extension"],
    ["captures reply context from botInvokeMessage wrapped quoted messages", "botInvokeMessage"],
    [
      "captures reply context from groupMentionedMessage wrapped quoted messages",
      "groupMentionedMessage",
    ],
  ])("%s", async (_name, wrapper) => {
    await expectQuotedReplyContext({
      [wrapper]: { message: { conversation: "original" } },
    });
  });
});
