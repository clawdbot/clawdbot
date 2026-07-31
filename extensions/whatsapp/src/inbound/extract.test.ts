// Whatsapp tests cover extract plugin behavior.
import { generateWAMessageFromContent, type proto } from "baileys";
import { describe, expect, it } from "vitest";
import {
  describeReplyContext,
  extractMediaKind,
  extractMentionedJids,
  extractText,
  hasInboundUserContent,
} from "./extract.js";

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

  it.each([
    {
      name: "template button replies",
      message: {
        templateButtonReplyMessage: {
          selectedId: "confirm",
          selectedDisplayText: "Confirm",
          contextInfo: { mentionedJid: [botJid] },
        },
      },
    },
    {
      name: "native interactive responses",
      message: {
        interactiveResponseMessage: {
          body: { text: "Continue" },
          contextInfo: { mentionedJid: [botJid] },
        },
      },
    },
    {
      name: "video notes",
      message: {
        ptvMessage: {
          mimetype: "video/mp4",
          contextInfo: { mentionedJid: [botJid] },
        },
      },
    },
    {
      name: "native polls",
      message: {
        pollCreationMessageV3: {
          name: "Lunch?",
          options: [{ optionName: "Pizza" }],
          contextInfo: { mentionedJid: [botJid] },
        },
      },
    },
  ])("preserves direct bot mentions from $name", ({ message }) => {
    expect(extractMentionedJids(message as proto.IMessage)).toEqual([botJid]);
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

describe("describeReplyContext", () => {
  it("preserves a native reply reference when WhatsApp omits the quoted message", () => {
    expect(
      describeReplyContext({
        extendedTextMessage: {
          text: "yes",
          contextInfo: {
            stanzaId: "original-message",
            participant: "15555550123@s.whatsapp.net",
          },
        },
      }),
    ).toMatchObject({
      id: "original-message",
      body: "[quoted message unavailable]",
      sender: {
        jid: "15555550123@s.whatsapp.net",
        e164: "+15555550123",
        label: "+15555550123",
      },
    });
  });

  it("preserves an unavailable reply reference without a quoted sender", () => {
    expect(
      describeReplyContext({
        extendedTextMessage: {
          text: "yes",
          contextInfo: { stanzaId: "original-message" },
        },
      }),
    ).toMatchObject({
      id: "original-message",
      body: "[quoted message unavailable]",
      sender: { label: "unknown sender" },
    });
  });

  it("does not invent a reply from unrelated context metadata", () => {
    expect(
      describeReplyContext({
        extendedTextMessage: {
          text: "hello",
          contextInfo: { participant: "15555550123@s.whatsapp.net" },
        },
      }),
    ).toBeNull();
  });

  it("preserves a quoted poll encoded through the real Baileys message generator", () => {
    const userJid = "15555550123@s.whatsapp.net";
    const generated = generateWAMessageFromContent(
      "120363000000000000@g.us",
      { extendedTextMessage: { text: "Choose pizza" } },
      {
        userJid,
        quoted: {
          key: {
            id: "original-poll",
            remoteJid: "120363000000000000@g.us",
            participant: userJid,
            fromMe: false,
          },
          message: {
            pollCreationMessageV3: {
              name: "Lunch?",
              options: [{ optionName: "Pizza" }, { optionName: "Sushi" }],
            },
          },
        },
      },
    );

    expect(describeReplyContext(generated.message ?? undefined)).toMatchObject({
      id: "original-poll",
      body: "Lunch?\n- Pizza\n- Sushi",
      sender: { jid: userJid },
    });
  });
});

describe("extractText", () => {
  it.each([
    {
      name: "button display text",
      message: {
        buttonsResponseMessage: { selectedButtonId: "yes", selectedDisplayText: "Yes" },
      },
      expected: "Yes",
    },
    {
      name: "button identifier when display text is unavailable",
      message: { buttonsResponseMessage: { selectedButtonId: "yes" } },
      expected: "yes",
    },
    {
      name: "button identifier when display text is blank",
      message: {
        buttonsResponseMessage: { selectedButtonId: "yes", selectedDisplayText: "   " },
      },
      expected: "yes",
    },
    {
      name: "list selection title",
      message: {
        listResponseMessage: { title: "Option A", singleSelectReply: { selectedRowId: "a" } },
      },
      expected: "Option A",
    },
    {
      name: "list row identifier when its title is unavailable",
      message: { listResponseMessage: { singleSelectReply: { selectedRowId: "a" } } },
      expected: "a",
    },
    {
      name: "template button display text",
      message: {
        templateButtonReplyMessage: { selectedId: "button-1", selectedDisplayText: "Confirm" },
      },
      expected: "Confirm",
    },
    {
      name: "template button identifier when display text is unavailable",
      message: { templateButtonReplyMessage: { selectedId: "button-1" } },
      expected: "button-1",
    },
    {
      name: "interactive response body",
      message: {
        interactiveResponseMessage: {
          body: { text: "Continue" },
          nativeFlowResponseMessage: { name: "single_select", paramsJson: "{}" },
        },
      },
      expected: "Continue",
    },
    {
      name: "native-flow selection title when the interactive body is unavailable",
      message: {
        interactiveResponseMessage: {
          nativeFlowResponseMessage: {
            name: "single_select",
            paramsJson: '{"id":"shipping-express","title":"Express shipping"}',
          },
        },
      },
      expected: "Express shipping",
    },
    {
      name: "native-flow selection identifier when its title is unavailable",
      message: {
        interactiveResponseMessage: {
          nativeFlowResponseMessage: {
            name: "single_select",
            paramsJson: '{"id":"shipping-express"}',
          },
        },
      },
      expected: "shipping-express",
    },
    {
      name: "ephemeral button response",
      message: {
        ephemeralMessage: {
          message: {
            buttonsResponseMessage: { selectedButtonId: "ok", selectedDisplayText: "OK" },
          },
        },
      },
      expected: "OK",
    },
    {
      name: "native multiple-choice poll",
      message: {
        pollCreationMessage: {
          name: "Lunch?",
          options: [{ optionName: "Pizza" }, { optionName: "Sushi" }],
        },
      },
      expected: "Lunch?\n- Pizza\n- Sushi",
    },
    {
      name: "native announcement-group poll",
      message: {
        pollCreationMessageV2: {
          name: "Lunch?",
          options: [{ optionName: "Pizza" }],
        },
      },
      expected: "Lunch?\n- Pizza",
    },
    {
      name: "native single-select poll",
      message: {
        pollCreationMessageV3: {
          name: "Lunch?",
          options: [{ optionName: "Pizza" }],
        },
      },
      expected: "Lunch?\n- Pizza",
    },
    {
      name: "future-proof native poll",
      message: {
        pollCreationMessageV4: {
          message: {
            pollCreationMessageV3: {
              name: "Lunch?",
              options: [{ optionName: "Pizza" }],
            },
          },
        },
      },
      expected: "Lunch?\n- Pizza",
    },
    {
      name: "native poll with blank options filtered",
      message: {
        pollCreationMessageV5: {
          name: " Lunch? ",
          options: [{ optionName: " " }, { optionName: " Pizza " }],
        },
      },
      expected: "Lunch?\n- Pizza",
    },
    {
      name: "video-note caption",
      message: { ptvMessage: { caption: "Watch this", mimetype: "video/mp4" } },
      expected: "Watch this",
    },
  ])("preserves $name as inbound message text", ({ message, expected }) => {
    expect(extractText(message as proto.IMessage)).toBe(expected);
  });

  it("ignores malformed native-flow response JSON", () => {
    expect(
      extractText({
        interactiveResponseMessage: {
          nativeFlowResponseMessage: { name: "single_select", paramsJson: "{" },
        },
      } as proto.IMessage),
    ).toBeUndefined();
  });

  it("ignores non-record native-flow response JSON", () => {
    expect(
      extractText({
        interactiveResponseMessage: {
          nativeFlowResponseMessage: { name: "single_select", paramsJson: "[]" },
        },
      } as proto.IMessage),
    ).toBeUndefined();
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

  it("classifies captionless video notes as user-visible video media", () => {
    const message = { ptvMessage: { mimetype: "video/mp4" } } as proto.IMessage;

    expect(extractMediaKind(message)).toBe("video");
    expect(hasInboundUserContent(message)).toBe(true);
  });

  it.each([
    "pollCreationMessage",
    "pollCreationMessageV2",
    "pollCreationMessageV3",
    "pollCreationMessageV5",
  ] as const)("admits populated %s as user-visible content", (pollKey) => {
    expect(
      hasInboundUserContent({
        [pollKey]: { name: "Lunch?", options: [{ optionName: "Pizza" }] },
      } as proto.IMessage),
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

  it("does not admit an empty native poll envelope", () => {
    expect(
      hasInboundUserContent({
        pollCreationMessage: { name: " ", options: [{ optionName: " " }] },
      } as proto.IMessage),
    ).toBe(false);
  });
});
