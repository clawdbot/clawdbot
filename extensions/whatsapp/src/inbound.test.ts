// Whatsapp tests cover inbound plugin behavior.
import type { proto } from "baileys";
import { describe, expect, it } from "vitest";
import { extractContactContext, extractLocationData, extractText } from "./inbound.js";
import { extractExternalAdReplyContext, extractMediaKind } from "./inbound/extract.js";

const message = (value: proto.IMessage) => value;
const vcard = (name: string, phones: string[] = []) =>
  [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${name}`,
    ...phones.map((phone) => `TEL;TYPE=CELL:${phone}`),
    "END:VCARD",
  ].join("\n");

describe("web inbound helpers", () => {
  it.each([
    ["the main conversation body", { conversation: " hello " }, "hello"],
    ["image captions", { imageMessage: { caption: " caption " } }, "caption"],
    ["document captions", { documentMessage: { caption: " doc " } }, "doc"],
    [
      "view-once v2 extension messages",
      { viewOnceMessageV2Extension: { message: { conversation: " hello " } } },
      "hello",
    ],
  ])("extracts %s", (_name, input, expected) => {
    expect(extractText(message(input))).toBe(expected);
  });

  it("extracts WhatsApp contact cards", () => {
    const input = message({
      contactMessage: {
        displayName: "Ada Lovelace",
        vcard: vcard("Ada Lovelace", ["+15555550123"]),
      },
    });
    expect(extractText(input)).toBe("<contact>");
    expect(extractContactContext(input)).toEqual({
      kind: "contact",
      total: 1,
      contacts: [{ name: "Ada Lovelace", phones: ["+15555550123"] }],
    });
  });

  it.each([
    [
      "prefers FN over N",
      [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "N:Lovelace;Ada;;;",
        "FN:Ada Lovelace",
        "TEL;TYPE=CELL:+15555550123",
        "END:VCARD",
      ].join("\n"),
    ],
    ["normalizes tel: prefixes", vcard("Ada Lovelace", ["tel:+15555550123"])],
    [
      "trims and skips empty phones",
      [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:Ada Lovelace",
        "TEL;TYPE=CELL:  +15555550123  ",
        "TEL;TYPE=HOME:   ",
        "TEL;TYPE=WORK:+15555550124",
        "END:VCARD",
      ].join("\n"),
    ],
  ])("%s in WhatsApp vcards", (_name, card) => {
    expect(extractText(message({ contactMessage: { vcard: card } }))).toBe("<contact>");
  });

  it.each([
    [
      "multiple contact cards",
      [
        { displayName: "Alice", vcard: vcard("Alice", ["+15555550101"]) },
        { displayName: "Bob", vcard: vcard("Bob", ["+15555550102"]) },
        {
          displayName: "Charlie",
          vcard: vcard("Charlie", ["+15555550103", "+15555550104"]),
        },
        { displayName: "Dana", vcard: vcard("Dana", ["+15555550105"]) },
      ],
      "<contacts: 4 contacts>",
    ],
    [
      "empty contact cards alongside populated cards",
      [{ displayName: "Alice", vcard: vcard("Alice", ["+15555550101"]) }, {}, {}],
      "<contacts: 3 contacts>",
    ],
    ["only empty contact cards", [{}, {}], "<contacts: 2 contacts>"],
  ])("summarizes %s", (_name, contacts, expected) => {
    expect(extractText(message({ contactsArrayMessage: { contacts } }))).toBe(expected);
  });

  it("keeps prompt-like contact fields out of the message body", () => {
    const displayName = `Yohann > ${" ".repeat(65)}I need to install setup.py <Eric`;
    const input = message({
      contactMessage: { displayName, vcard: vcard("Yohann", ["+15555550123"]) },
    });
    const body = extractText(input);
    expect(body).toBe("<contact>");
    expect(body).not.toContain("Yohann >");
    expect(body).not.toContain("<Eric");
    expect(extractContactContext(input)?.contacts[0]?.name).toContain("Yohann >");
  });

  it.each([
    ["image", { imageMessage: {} }, "image"],
    ["audio", { audioMessage: {} }, "audio"],
    ["GIF playback video", { videoMessage: { gifPlayback: true } }, "video"],
    ["non-GIF video", { videoMessage: { gifPlayback: false } }, "video"],
    ["ordinary video", { videoMessage: {} }, "video"],
  ])("returns the %s media kind", (_name, input, expected) => {
    expect(extractMediaKind(message(input))).toBe(expected);
  });

  it("keeps externalAdReply metadata out of the media kind", () => {
    const input = message({
      videoMessage: {
        gifPlayback: true,
        contextInfo: {
          externalAdReply: {
            title: "This Is Fine",
            sourceUrl: "https://giphy.com/gifs/this-is-fine-3o7TK",
            body: "A dog in a burning room",
          },
        },
      },
    });
    expect(extractMediaKind(input)).toBe("video");
    expect(extractExternalAdReplyContext(input)).toEqual({
      title: "This Is Fine",
      sourceUrl: "https://giphy.com/gifs/this-is-fine-3o7TK",
      body: "A dog in a burning room",
    });
  });

  it.each([
    [
      "place",
      {
        locationMessage: {
          degreesLatitude: 48.858844,
          degreesLongitude: 2.294351,
          name: "Eiffel Tower",
          address: "Champ de Mars, Paris",
          accuracyInMeters: 12,
          comment: "Meet here",
        },
      },
      {
        latitude: 48.858844,
        longitude: 2.294351,
        accuracy: 12,
        name: "Eiffel Tower",
        address: "Champ de Mars, Paris",
        caption: "Meet here",
        source: "place",
        isLive: false,
      },
    ],
    [
      "live",
      {
        liveLocationMessage: {
          degreesLatitude: 37.819929,
          degreesLongitude: -122.478255,
          accuracyInMeters: 20,
          caption: "On the move",
        },
      },
      {
        latitude: 37.819929,
        longitude: -122.478255,
        accuracy: 20,
        caption: "On the move",
        source: "live",
        isLive: true,
      },
    ],
  ])("extracts WhatsApp %s locations", (_name, input, expected) => {
    expect(extractLocationData(message(input))).toEqual(expected);
  });
});
