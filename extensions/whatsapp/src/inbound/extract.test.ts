import type { proto } from "baileys";
import { describe, expect, it } from "vitest";
import { extractMentionedJids, hasInboundUserContent } from "./extract.js";

describe("extractMentionedJids", () => {
  const botJid = "5511999999999@s.whatsapp.net";
  const otherJid = "5511888888888@s.whatsapp.net";

  it("returns direct mentions from the current message", () => {
    const message: proto.IMessage = {
      extendedTextMessage: {
        text: "Hey @bot",
        contextInfo: {
          mentionedJid: [botJid],
        },
      },
    };
    expect(extractMentionedJids(message)).toEqual([botJid]);
  });

  it("ignores mentionedJids from quoted messages", () => {
    const message: proto.IMessage = {
      extendedTextMessage: {
        text: "I agree",
        contextInfo: {
          // The quoted message originally @mentioned the bot, but the
          // current message does not — this should NOT leak through.
          quotedMessage: {
            extendedTextMessage: {
              text: "Hey @bot what do you think?",
              contextInfo: {
                mentionedJid: [botJid],
              },
            },
          },
        },
      },
    };
    expect(extractMentionedJids(message)).toBeUndefined();
  });

  it("returns direct mentions even when quoted message also has mentions", () => {
    const message: proto.IMessage = {
      extendedTextMessage: {
        text: "Hey @other",
        contextInfo: {
          mentionedJid: [otherJid],
          quotedMessage: {
            extendedTextMessage: {
              text: "Hey @bot",
              contextInfo: {
                mentionedJid: [botJid],
              },
            },
          },
        },
      },
    };
    // Should return only the direct mention, not the quoted one.
    expect(extractMentionedJids(message)).toEqual([otherJid]);
  });

  it("returns mentions from media message types", () => {
    const message: proto.IMessage = {
      imageMessage: {
        contextInfo: {
          mentionedJid: [botJid],
        },
      },
    };
    expect(extractMentionedJids(message)).toEqual([botJid]);
  });

  it("returns undefined for messages with no mentions", () => {
    const message: proto.IMessage = {
      extendedTextMessage: {
        text: "Just a regular message",
      },
    };
    expect(extractMentionedJids(message)).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(extractMentionedJids(undefined)).toBeUndefined();
  });

  it("deduplicates mentions across message types", () => {
    const message: proto.IMessage = {
      extendedTextMessage: {
        text: "Hey @bot",
        contextInfo: {
          mentionedJid: [botJid],
        },
      },
      imageMessage: {
        contextInfo: {
          mentionedJid: [botJid],
        },
      },
    };
    expect(extractMentionedJids(message)).toEqual([botJid]);
  });
});

describe("hasInboundUserContent", () => {
  it("returns true for plain text conversation", () => {
    expect(hasInboundUserContent({ conversation: "hello" })).toBe(true);
  });

  it("returns true for extendedTextMessage", () => {
    expect(
      hasInboundUserContent({ extendedTextMessage: { text: "hello" } } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for image message", () => {
    expect(
      hasInboundUserContent({ imageMessage: { mimetype: "image/png" } } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for video message", () => {
    expect(
      hasInboundUserContent({ videoMessage: { mimetype: "video/mp4" } } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for audio message", () => {
    expect(
      hasInboundUserContent({ audioMessage: { mimetype: "audio/ogg" } } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for document message", () => {
    expect(
      hasInboundUserContent({
        documentMessage: { fileName: "x.pdf" },
      } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for sticker message", () => {
    expect(
      hasInboundUserContent({ stickerMessage: { mimetype: "image/webp" } } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for location message with valid coords", () => {
    expect(
      hasInboundUserContent({
        locationMessage: { degreesLatitude: 1, degreesLongitude: 2 },
      } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for live location message with valid coords", () => {
    expect(
      hasInboundUserContent({
        liveLocationMessage: { degreesLatitude: 1, degreesLongitude: 2 },
      } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for contact message", () => {
    expect(
      hasInboundUserContent({
        contactMessage: { displayName: "Alice", vcard: "BEGIN:VCARD\nEND:VCARD" },
      } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for contactsArrayMessage via contact placeholder extraction", () => {
    expect(
      hasInboundUserContent({
        contactsArrayMessage: {
          contacts: [{ displayName: "Alice", vcard: "BEGIN:VCARD\nEND:VCARD" }],
        },
      } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for buttons response (user button click)", () => {
    expect(
      hasInboundUserContent({
        buttonsResponseMessage: {
          selectedButtonId: "yes",
          selectedDisplayText: "Yes",
        },
      } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for list response (user list selection)", () => {
    expect(
      hasInboundUserContent({
        listResponseMessage: {
          title: "Option A",
          singleSelectReply: { selectedRowId: "a" },
        } as unknown as proto.Message.IListResponseMessage,
      } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for template button reply", () => {
    expect(
      hasInboundUserContent({
        templateButtonReplyMessage: {
          selectedId: "btn-1",
          selectedDisplayText: "Click",
        } as unknown as proto.Message.ITemplateButtonReplyMessage,
      } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for interactive response", () => {
    expect(
      hasInboundUserContent({
        interactiveResponseMessage: {
          body: { text: "x" },
          nativeFlowResponseMessage: { name: "n", paramsJson: "{}" },
        } as unknown as proto.Message.IInteractiveResponseMessage,
      } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for buttons response wrapped in ephemeralMessage (regression for #73797 + greptile review)", () => {
    expect(
      hasInboundUserContent({
        ephemeralMessage: {
          message: {
            buttonsResponseMessage: {
              selectedButtonId: "ok",
              selectedDisplayText: "OK",
            },
          },
        },
      } as proto.IMessage),
    ).toBe(true);
  });

  it("returns false for undefined message (regression for #73797)", () => {
    expect(hasInboundUserContent(undefined)).toBe(false);
  });

  it("returns false for empty message object (no content keys)", () => {
    expect(hasInboundUserContent({} as proto.IMessage)).toBe(false);
  });

  it("returns false for protocol message envelope without inner content (regression for #73797)", () => {
    expect(
      hasInboundUserContent({
        protocolMessage: {
          type: 0,
        } as unknown as proto.Message.IProtocolMessage,
      } as proto.IMessage),
    ).toBe(false);
  });

  it("returns false for receipt-style senderKeyDistribution-only payload (regression for #73797)", () => {
    expect(
      hasInboundUserContent({
        senderKeyDistributionMessage: {
          groupId: "g@example",
        } as unknown as proto.Message.ISenderKeyDistributionMessage,
      } as proto.IMessage),
    ).toBe(false);
  });

  it("returns false when location coords are missing (incomplete event, regression for #73797)", () => {
    expect(
      hasInboundUserContent({
        locationMessage: { name: "no coords" },
      } as proto.IMessage),
    ).toBe(false);
  });

  it("returns false when extendedTextMessage has only empty text", () => {
    expect(hasInboundUserContent({ extendedTextMessage: { text: "  " } } as proto.IMessage)).toBe(
      false,
    );
  });
});
