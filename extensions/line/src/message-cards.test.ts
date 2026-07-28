// Line tests cover message cards plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  datetimePickerAction,
  messageAction,
  normalizeLineAction,
  postbackAction,
  truncateLineActionLabel,
  uriAction,
  type Action,
} from "./actions.js";
import { registerLineCardCommand } from "./card-command.js";
import {
  createActionCard,
  createAppleTvRemoteCard,
  createCarousel,
  createDeviceControlCard,
  createEventCard,
  createImageCard,
  createInfoCard,
  createListCard,
  createMediaPlayerCard,
} from "./flex-templates.js";
import {
  buildTemplateMessageFromPayload,
  createConfirmTemplate,
  createButtonTemplate,
  createTemplateCarousel,
  createCarouselColumn,
  createImageCarousel,
  createImageCarouselColumn,
  createProductCarousel,
} from "./template-messages.js";

const loneHighSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;

describe("createConfirmTemplate", () => {
  it("truncates text to 240 characters", () => {
    const longText = "x".repeat(300);
    const template = createConfirmTemplate(longText, messageAction("Yes"), messageAction("No"));

    expect((template.template as { text: string }).text.length).toBe(240);
  });

  it("drops a surrogate-pair emoji from fallback altText instead of splitting it", () => {
    const template = createConfirmTemplate(
      `${"x".repeat(399)}😀`,
      messageAction("Yes"),
      messageAction("No"),
    );

    expect(template.altText).toBe("x".repeat(399));
    expect(loneHighSurrogate.test(template.altText)).toBe(false);
  });
});

describe("createButtonTemplate", () => {
  it("omits a blank optional title", () => {
    const template = createButtonTemplate(undefined, "Text", [messageAction("OK")]);
    expect(template).toMatchObject({
      altText: "Text",
      template: { type: "buttons", text: "Text" },
    });
    expect(template.template).not.toHaveProperty("title");
  });

  it("uses the titleless 160-character text limit for an empty title", () => {
    const template = createButtonTemplate("", "x".repeat(160), [messageAction("OK")]);
    expect(template.template).toMatchObject({ text: "x".repeat(160) });
  });

  it("limits actions to 4", () => {
    const actions = Array.from({ length: 6 }, (_, i) => messageAction(`Button ${i}`));
    const template = createButtonTemplate("Title", "Text", actions);

    expect((template.template as { actions: unknown[] }).actions.length).toBe(4);
  });

  it("truncates title to 40 characters", () => {
    const longTitle = "x".repeat(50);
    const template = createButtonTemplate(longTitle, "Text", [messageAction("OK")]);

    expect((template.template as { title: string }).title.length).toBe(40);
  });

  it("drops a surrogate-pair emoji from the title instead of splitting it", () => {
    // 39 chars + an emoji land the truncation boundary inside the surrogate pair;
    // a raw code-unit slice would keep only the lone high surrogate.
    const template = createButtonTemplate(`${"x".repeat(39)}😀`, "Text", [messageAction("OK")]);
    const title = (template.template as { title: string }).title;

    expect(title).toBe("x".repeat(39));
    expect(loneHighSurrogate.test(title)).toBe(false);
  });

  it("drops a surrogate-pair emoji from explicit altText instead of splitting it", () => {
    const template = createButtonTemplate("Title", "Text", [messageAction("OK")], {
      altText: `${"x".repeat(399)}😀`,
    });

    expect(template.altText).toBe("x".repeat(399));
    expect(loneHighSurrogate.test(template.altText)).toBe(false);
  });

  it("truncates text to 60 chars when no thumbnail is provided", () => {
    const longText = "x".repeat(100);
    const template = createButtonTemplate("Title", longText, [messageAction("OK")]);

    expect((template.template as { text: string }).text.length).toBe(60);
  });

  it("truncates text to 60 chars when title and thumbnail are provided", () => {
    const longText = "x".repeat(100);
    const template = createButtonTemplate("Title", longText, [messageAction("OK")], {
      thumbnailImageUrl: "https://example.com/thumb.jpg",
    });

    expect((template.template as { text: string }).text.length).toBe(60);
  });
});

describe("createCarouselColumn", () => {
  it("limits actions to 3", () => {
    const column = createCarouselColumn({
      text: "Text",
      actions: [
        messageAction("A1"),
        messageAction("A2"),
        messageAction("A3"),
        messageAction("A4"),
        messageAction("A5"),
      ],
    });

    expect(column.actions.length).toBe(3);
  });

  it("truncates text to 120 characters when no title or image is set", () => {
    const longText = "x".repeat(150);
    const column = createCarouselColumn({ text: longText, actions: [messageAction("OK")] });

    expect(column.text.length).toBe(120);
  });

  it("truncates text to 60 characters when a title is set", () => {
    const longText = "x".repeat(150);
    const column = createCarouselColumn({
      title: "Title",
      text: longText,
      actions: [messageAction("OK")],
    });

    expect(column.text.length).toBe(60);
  });

  it("drops a surrogate-pair emoji from the title instead of splitting it", () => {
    const column = createCarouselColumn({
      title: `${"x".repeat(39)}😀`,
      text: "Text",
      actions: [messageAction("OK")],
    });

    expect(column.title).toBe("x".repeat(39));
    expect(loneHighSurrogate.test(column.title ?? "")).toBe(false);
  });

  it("does not split an emoji grapheme at the 60-code-unit boundary", () => {
    const text = `${"x".repeat(59)}👨‍👩‍👧‍👦after`;
    const column = createCarouselColumn({
      title: "Title",
      text,
      actions: [messageAction("OK")],
    });

    expect(column.text).toBe("x".repeat(59));
  });

  it("keeps required text when the first grapheme exceeds the limit", () => {
    const text = `😀${"\u0301".repeat(59)}`;
    const column = createCarouselColumn({
      title: "Title",
      text,
      actions: [messageAction("OK")],
    });

    expect(column.text.length).toBe(60);
    expect(column.text.startsWith("😀")).toBe(true);
  });

  it("uses the compact limit when a whitespace-only title is present", () => {
    const column = createCarouselColumn({
      title: " ",
      text: "x".repeat(150),
      actions: [messageAction("OK")],
    });

    expect(column.text).toBe("x".repeat(60));
  });

  it("truncates text to 60 characters when a thumbnail image is set", () => {
    const longText = "x".repeat(150);
    const column = createCarouselColumn({
      text: longText,
      thumbnailImageUrl: "https://example.com/thumb.jpg",
      actions: [messageAction("OK")],
    });

    expect(column.text.length).toBe(60);
  });
});

describe("carousel column limits", () => {
  it.each([
    {
      createTemplate: () =>
        createTemplateCarousel(
          Array.from({ length: 15 }, () =>
            createCarouselColumn({ text: "Text", actions: [messageAction("OK")] }),
          ),
        ),
    },
    {
      createTemplate: () =>
        createImageCarousel(
          Array.from({ length: 15 }, (_, i) =>
            createImageCarouselColumn(`https://example.com/${i}.jpg`, messageAction("View")),
          ),
        ),
    },
  ])("limits columns to 10", ({ createTemplate }) => {
    const template = createTemplate();
    expect((template.template as { columns: unknown[] }).columns.length).toBe(10);
  });

  it("drops a surrogate-pair emoji from image-carousel altText instead of splitting it", () => {
    const template = createImageCarousel(
      [createImageCarouselColumn("https://example.com/0.jpg", messageAction("View"))],
      `${"x".repeat(399)}😀`,
    );

    expect(template.altText).toBe("x".repeat(399));
    expect(loneHighSurrogate.test(template.altText)).toBe(false);
  });

  it("keeps unavailable action labels within the image-carousel cap", () => {
    const template = createImageCarousel([
      createImageCarouselColumn(
        "https://example.com/0.jpg",
        uriAction("Open", `https://example.com/?q=${"x".repeat(1200)}`),
      ),
    ]);
    const column = (
      template.template as {
        columns: Array<{ action: { label?: string; text?: string; type: string } }>;
      }
    ).columns[0];

    expect(column?.action).toEqual({
      type: "message",
      label: "Unavailable",
      text: "Link unavailable: URL exceeds LINE's limit.",
    });
    expect(column?.action.label).toHaveLength(11);
  });
});

describe("createProductCarousel", () => {
  it.each([
    {
      title: "Product",
      description: "Desc",
      actionLabel: "Buy",
      actionUrl: "https://shop.com/buy",
      expectedType: "uri",
    },
    {
      title: "Product",
      description: "Desc",
      actionLabel: "Select",
      actionData: "product_id=123",
      expectedType: "postback",
    },
  ])("uses expected action type for product action", ({ expectedType, ...item }) => {
    const template = createProductCarousel([item]);
    const columns = (template.template as { columns: Array<{ actions: Array<{ type: string }> }> })
      .columns;
    const column = expectDefined(columns[0], "product carousel column");
    expect(expectDefined(column.actions[0], "product carousel action").type).toBe(expectedType);
  });

  it("preserves the complete price when truncating a long description", () => {
    const template = createProductCarousel([
      {
        title: "Product",
        description: "x".repeat(59),
        price: "$12.99",
      },
    ]);
    const columns = (template.template as { columns: Array<{ text: string }> }).columns;

    const column = expectDefined(columns[0], "priced product carousel column");
    expect(column.text).toBe(`${"x".repeat(53)}\n$12.99`);
    expect(column.text.length).toBe(60);
  });
});

describe("flex cards", () => {
  it("includes footer when provided", () => {
    const card = createInfoCard("Title", "Body", "Footer text");

    const footer = card.footer as { contents: Array<{ text: string }> };
    expect(expectDefined(footer.contents[0], "info-card footer content").text).toBe("Footer text");
  });

  it("limits list items to 8", () => {
    const items = Array.from({ length: 15 }, (_, i) => ({ title: `Item ${i}` }));
    const card = createListCard("List", items);

    const body = card.body as { contents: Array<{ type: string; contents?: unknown[] }> };
    const listBox = body.contents[2] as { contents: unknown[] };
    expect(listBox.contents.length).toBe(8);
  });

  it("includes image-card body text when provided", () => {
    const card = createImageCard("https://example.com/img.jpg", "Title", "Body text");

    const body = card.body as { contents: Array<{ text: string }> };
    expect(body.contents.length).toBe(2);
    expect(expectDefined(body.contents[1], "image-card body content").text).toBe("Body text");
  });

  it("limits action-card actions to 4", () => {
    const actions = Array.from({ length: 6 }, (_, i) => ({
      label: `Action ${i}`,
      action: { type: "message" as const, label: `A${i}`, text: `action${i}` },
    }));
    const card = createActionCard("Title", "Body", actions);

    const footer = card.footer as { contents: unknown[] };
    expect(footer.contents.length).toBe(4);
  });

  it("limits carousels to 12 bubbles", () => {
    const bubbles = Array.from({ length: 15 }, (_, i) => createInfoCard(`Card ${i}`, `Body ${i}`));
    const carousel = createCarousel(bubbles);

    expect(carousel.contents.length).toBe(12);
  });

  it("limits device controls to 6", () => {
    const card = createDeviceControlCard({
      deviceName: "Device",
      controls: Array.from({ length: 10 }, (_, i) => ({
        label: `Control ${i}`,
        data: `action=${i}`,
      })),
    });

    const footer = card.footer as { contents: unknown[] };
    expect(footer.contents.length).toBeLessThanOrEqual(3);
  });

  it("keeps event-card optional fields together", () => {
    const card = createEventCard({
      title: "Team Offsite",
      date: "February 15, 2026",
      time: "9:00 AM - 5:00 PM",
      location: "Mountain View Office",
      description: "Annual team building event",
    });

    expect(card.size).toBe("mega");
    const body = card.body as { contents: Array<{ type: string }> };
    expect(body.contents).toHaveLength(3);
  });
});

describe("action label/data surrogate-safe truncation", () => {
  // 19 ASCII chars + 😀 (U+1F600, two UTF-16 code units) = 21 code units; a raw
  // .slice(0, 20) would keep the first 19 chars plus the lone high surrogate.
  const labelWithEmoji = "1234567890123456789😀";

  it("messageAction drops a half emoji instead of leaving a lone surrogate", () => {
    const action = messageAction(labelWithEmoji) as { label: string };

    expect(action.label).toBe(labelWithEmoji);
    expect(loneHighSurrogate.test(action.label)).toBe(false);
  });

  it("messageAction leaves a short ASCII label unchanged", () => {
    const action = messageAction("Yes");

    expect(action.label).toBe("Yes");
  });

  it("uriAction drops a half emoji instead of leaving a lone surrogate", () => {
    const action = uriAction(labelWithEmoji, "https://example.com") as { label: string };

    expect(action.label).toBe(labelWithEmoji);
    expect(loneHighSurrogate.test(action.label)).toBe(false);
  });

  it("postbackAction preserves valid grapheme labels but disables overlong callback data", () => {
    const exactData = `${"d".repeat(298)}😀`;
    const overlongData = `${"d".repeat(299)}😀`;
    const action = postbackAction(labelWithEmoji, "data") as { label: string };
    const exact = postbackAction("Label", exactData) as { data: string };
    const unavailable = postbackAction("Label", overlongData);

    expect(exactData).toHaveLength(300);
    expect(overlongData).toHaveLength(301);
    expect(action.label).toBe(labelWithEmoji);
    expect(loneHighSurrogate.test(action.label)).toBe(false);
    expect(exact.data).toBe(exactData);
    expect(unavailable).toEqual({
      type: "message",
      label: "Unavailable",
      text: "Action unavailable: callback data exceeds LINE's limit.",
    });
  });

  it("postbackAction truncates displayText by grapheme cluster but keeps undefined", () => {
    const displayText = `${"t".repeat(300)}😀`;
    const withDisplay = postbackAction("Label", "data", displayText) as {
      displayText?: string;
    };
    const withoutDisplay = postbackAction("Label", "data") as { displayText?: string };

    expect(withDisplay.displayText).toBe("t".repeat(300));
    expect(loneHighSurrogate.test(withDisplay.displayText ?? "")).toBe(false);
    expect(withoutDisplay.displayText).toBeUndefined();
  });

  it("datetimePickerAction preserves valid grapheme labels but disables overlong callback data", () => {
    const exactData = `${"d".repeat(298)}😀`;
    const overlongData = `${"d".repeat(299)}😀`;
    const action = datetimePickerAction(labelWithEmoji, "data", "datetime") as { label: string };
    const exact = datetimePickerAction("Pick", exactData, "datetime") as { data: string };
    const unavailable = datetimePickerAction("Pick", overlongData, "datetime");

    expect(exactData).toHaveLength(300);
    expect(overlongData).toHaveLength(301);
    expect(action.label).toBe(labelWithEmoji);
    expect(loneHighSurrogate.test(action.label)).toBe(false);
    expect(exact.data).toBe(exactData);
    expect(unavailable).toEqual({
      type: "message",
      label: "Unavailable",
      text: "Action unavailable: callback data exceeds LINE's limit.",
    });
  });

  it("/card action command visibly disables overlong callback data", async () => {
    const registerCommand = (command: unknown) => {
      const { handler } = command as {
        handler: (ctx: { args: string; channel: string }) => Promise<unknown>;
      };
      return handler({
        channel: "line",
        args: `action "Menu" "Body" --actions "${labelWithEmoji}|k=${"d".repeat(297)}😀"`,
      });
    };
    const result = (await registerCommandWithHandler(registerCommand)) as {
      channelData: {
        line: {
          flexMessage: {
            contents: {
              footer: {
                contents: Array<{
                  action: { type: string; label: string; text?: string };
                }>;
              };
            };
          };
        };
      };
    };
    const action = expectDefined(
      result.channelData.line.flexMessage.contents.footer.contents[0],
      "LINE flex-message footer action",
    ).action;

    expect(action).toEqual({
      type: "message",
      label: "Unavailable",
      text: "Action unavailable: callback data exceeds LINE's limit.",
    });
  });

  it("/card receipt altText truncates on a surrogate boundary", async () => {
    // The emoji's surrogate pair straddles the 400-char altText cap; a raw
    // slice used to leave a lone high surrogate in the receipt flex altText.
    const registerCommand = (command: unknown) => {
      const { handler } = command as {
        handler: (ctx: { args: string; channel: string }) => Promise<unknown>;
      };
      return handler({
        channel: "line",
        args: `receipt "R" "${"a".repeat(395)}:😀x" --total "$30"`,
      });
    };
    const result = (await registerCommandWithHandler(registerCommand)) as {
      channelData: { line: { flexMessage: { altText: string } } };
    };
    const altText = result.channelData.line.flexMessage.altText;

    expect(altText.length).toBeLessThanOrEqual(400);
    expect(loneHighSurrogate.test(altText)).toBe(false);
  });

  it("media control postback labels count grapheme clusters", () => {
    const card = createMediaPlayerCard({
      title: "Track",
      controls: {
        play: { data: "play" },
      },
      extraActions: [{ label: `${"x".repeat(14)}😀`, data: "extra" }],
    });
    const footer = card.footer as {
      contents: Array<{ contents?: Array<{ action?: { data?: string; label: string } }> }>;
    };
    const extraAction = footer.contents
      .flatMap((content) => content.contents ?? [])
      .find((button) => button.action?.data === "extra")?.action;

    expect(extraAction?.label).toBe(`${"x".repeat(14)}😀`);
    expect(loneHighSurrogate.test(extraAction?.label ?? "")).toBe(false);
  });

  it("uriAction visibly disables overlong links instead of changing their destination", () => {
    const validUri = `https://e.example/?q=${"u".repeat(979)}`;
    const validAction = uriAction("Open", validUri) as { type: string; uri?: string };
    const overlongAction = uriAction("Open", `${validUri}u`) as {
      type: string;
      label?: string;
      text?: string;
    };

    expect(validUri).toHaveLength(1000);
    expect(validAction).toMatchObject({ type: "uri", uri: validUri });
    expect(overlongAction).toEqual({
      type: "message",
      label: "Unavailable",
      text: "Link unavailable: URL exceeds LINE's limit.",
    });
  });

  it("buttons template payload visibly disables URIs past the 1000-unit cap", () => {
    const template = buildTemplateMessageFromPayload({
      type: "buttons",
      text: "Pick",
      actions: [{ type: "uri", label: "Open", uri: `https://e.example/?q=${"u".repeat(1200)}` }],
    });

    const buttonsTemplate = expectDefined(template, "buttons template message").template as {
      actions: Array<{ type: string; label?: string; text?: string }>;
    };
    const uriTemplateAction = expectDefined(
      buttonsTemplate.actions[0],
      "buttons template uri action",
    );
    expect(uriTemplateAction).toEqual({
      type: "message",
      label: "Unavailable",
      text: "Link unavailable: URL exceeds LINE's limit.",
    });
  });

  it("buttons template payload visibly disables overlong postback data", () => {
    const template = buildTemplateMessageFromPayload({
      type: "buttons",
      text: "Pick",
      actions: [{ type: "postback", label: "Open", data: `action=open&token=${"x".repeat(300)}` }],
    });
    const buttonsTemplate = expectDefined(template, "buttons template message").template as {
      actions: Array<{ type: string; label?: string; text?: string }>;
    };

    expect(buttonsTemplate.actions[0]).toEqual({
      type: "message",
      label: "Unavailable",
      text: "Action unavailable: callback data exceeds LINE's limit.",
    });
  });

  it("normalizes raw actions at exported template builder boundaries", () => {
    const oversizedPostback: Action = {
      type: "postback",
      label: "Open",
      data: "x".repeat(301),
    };
    const oversizedUri: Action = {
      type: "uri",
      label: "Open",
      uri: `https://e.example/?q=${"x".repeat(1200)}`,
    };
    const unavailableAction = {
      type: "message",
      label: "Unavailable",
      text: "Action unavailable: callback data exceeds LINE's limit.",
    };
    const unavailableLink = {
      type: "message",
      label: "Unavailable",
      text: "Link unavailable: URL exceeds LINE's limit.",
    };

    const buttons = createButtonTemplate(undefined, "Pick", [oversizedPostback], {
      defaultAction: oversizedUri,
    }).template as {
      actions: Action[];
      defaultAction?: Action;
    };
    expect(buttons.actions).toEqual([unavailableAction]);
    expect(buttons.defaultAction).toEqual(unavailableLink);

    const carousel = createTemplateCarousel([
      {
        text: "Pick",
        actions: [oversizedPostback],
        defaultAction: oversizedUri,
      },
    ]).template as {
      columns: Array<{ actions: Action[]; defaultAction?: Action }>;
    };
    expect(carousel.columns[0]?.actions).toEqual([unavailableAction]);
    expect(carousel.columns[0]?.defaultAction).toEqual(unavailableLink);

    const imageCarousel = createImageCarousel([
      { imageUrl: "https://e.example/image.jpg", action: oversizedPostback },
    ]).template as { columns: Array<{ action: Action }> };
    expect(imageCarousel.columns[0]?.action).toEqual(unavailableAction);
  });

  it("normalizes every length-constrained raw action field", () => {
    expect(
      normalizeLineAction({
        type: "uri",
        label: "Open",
        uri: "https://e.example",
        altUri: { desktop: `https://e.example/?q=${"x".repeat(1200)}` },
      }),
    ).toEqual({
      type: "message",
      label: "Unavailable",
      text: "Link unavailable: URL exceeds LINE's limit.",
    });

    const postback = normalizeLineAction({
      type: "postback",
      label: "Open",
      data: "action=open",
      displayText: "d".repeat(301),
    });
    expect(postback).toMatchObject({
      displayText: "d".repeat(300),
    });

    expect(normalizeLineAction({ type: "message", label: "Open", text: "x".repeat(301) })).toEqual({
      type: "message",
      label: "Unavailable",
      text: "Action unavailable: message text exceeds LINE's limit.",
    });
    expect(
      normalizeLineAction({
        type: "postback",
        label: "Open",
        data: "action=open",
        fillInText: "x".repeat(301),
      }),
    ).toEqual({
      type: "message",
      label: "Unavailable",
      text: "Action unavailable: message text exceeds LINE's limit.",
    });
    expect(
      normalizeLineAction({
        type: "postback",
        label: "Open",
        data: "action=open",
        text: "x".repeat(301),
      }),
    ).toEqual({
      type: "message",
      label: "Unavailable",
      text: "Action unavailable: message text exceeds LINE's limit.",
    });
    const emojiText = "😀".repeat(300);
    expect(messageAction("Open", emojiText)).toMatchObject({ text: emojiText });
    const familyEmoji = "👨‍👩‍👧‍👦";
    expect(truncateLineActionLabel(familyEmoji.repeat(3))).toBe(familyEmoji.repeat(2));
    expect(truncateLineActionLabel(`👩${"‍👩".repeat(10)}`)).toBe("…");
    expect(messageAction("Open", familyEmoji.repeat(43))).toEqual({
      type: "message",
      label: "Unavailable",
      text: "Action unavailable: message text exceeds LINE's limit.",
    });
    expect(messageAction("Open", familyEmoji.repeat(42))).toMatchObject({
      text: familyEmoji.repeat(42),
    });
    expect(
      normalizeLineAction({
        type: "clipboard",
        label: "Copy",
        clipboardText: "x".repeat(1001),
      }),
    ).toEqual({
      type: "message",
      label: "Unavailable",
      text: "Action unavailable: clipboard text exceeds LINE's limit.",
    });
  });

  it("normalizes raw actions at exported flex builder boundaries", () => {
    const oversizedUri: Action = {
      type: "uri",
      label: "Open",
      uri: `https://e.example/?q=${"x".repeat(1200)}`,
    };
    const oversizedPostback: Action = {
      type: "postback",
      label: "Open",
      data: "x".repeat(301),
    };

    const image = createImageCard("https://e.example/image.jpg", "Image", undefined, {
      action: oversizedUri,
    });
    expect((image.hero as { action?: Action }).action).toEqual({
      type: "message",
      label: "Unavailable",
      text: "Link unavailable: URL exceeds LINE's limit.",
    });

    const card = createActionCard("Title", "Body", [{ label: "Open", action: oversizedPostback }]);
    const button = (card.footer as { contents: Array<{ action: Action }> }).contents[0];
    expect(button?.action).toEqual({
      type: "message",
      label: "Unavailable",
      text: "Action unavailable: callback data exceeds LINE's limit.",
    });

    const validLongLabel = "x".repeat(40);
    const labeledCard = createActionCard("Title", "Body", [
      { label: validLongLabel, action: { type: "message", label: validLongLabel, text: "Open" } },
    ]);
    const labeledButton = (labeledCard.footer as { contents: Array<{ action: Action }> })
      .contents[0];
    expect(labeledButton?.action.label).toBe(validLongLabel);

    const list = createListCard("List", [{ title: "Item", action: oversizedPostback }]);
    const listBody = (list.body as { contents: unknown[] }).contents;
    const listBox = listBody[2] as {
      contents: Array<{ action?: Action }>;
    };
    expect(listBox.contents[0]?.action).toEqual({
      type: "message",
      label: "Unavailable",
      text: "Action unavailable: callback data exceeds LINE's limit.",
    });

    const event = createEventCard({
      title: "Event",
      date: "Today",
      action: oversizedUri,
    });
    expect((event.body as { action?: Action }).action).toEqual({
      type: "message",
      label: "Unavailable",
      text: "Link unavailable: URL exceeds LINE's limit.",
    });
  });

  it("media control cards visibly disable overlong opaque callbacks", () => {
    const overlongData = `${"d".repeat(299)}😀`;
    const card = createMediaPlayerCard({
      title: "Track",
      controls: {
        previous: { data: overlongData },
        play: { data: overlongData },
        pause: { data: overlongData },
        next: { data: overlongData },
      },
      extraActions: [{ label: "Extra", data: overlongData }],
    });
    const footer = card.footer as {
      contents: Array<{
        contents?: Array<{
          action?: { type: string; data?: string; label?: string; text?: string };
        }>;
      }>;
    };
    const actions = footer.contents
      .flatMap((content) => content.contents ?? [])
      .flatMap((button) => (button.action ? [button.action] : []));

    expect(actions).toHaveLength(5);
    for (const action of actions) {
      expect(action).toEqual({
        type: "message",
        label: "Unavailable",
        text: "Action unavailable: callback data exceeds LINE's limit.",
      });
    }
  });

  it("device controls visibly disable overlong opaque callbacks", () => {
    const card = createDeviceControlCard({
      deviceName: "Device",
      controls: [{ label: "On", data: `${"d".repeat(299)}😀` }],
    });
    const footer = card.footer as {
      contents: Array<{
        contents: Array<{
          action?: { type: string; data?: string; label?: string; text?: string };
        }>;
      }>;
    };
    const action = footer.contents
      .flatMap((row) => row.contents)
      .find((button) => button.action)?.action;

    expect(action).toEqual({
      type: "message",
      label: "Unavailable",
      text: "Action unavailable: callback data exceeds LINE's limit.",
    });
  });

  it("Apple TV controls visibly disable overlong opaque callbacks", () => {
    const overlongData = `${"d".repeat(299)}😀`;
    const card = createAppleTvRemoteCard({
      deviceName: "TV",
      actionData: {
        up: overlongData,
        down: overlongData,
        left: overlongData,
        right: overlongData,
        select: overlongData,
        menu: overlongData,
        home: overlongData,
        play: overlongData,
        pause: overlongData,
        volumeUp: overlongData,
        volumeDown: overlongData,
        mute: overlongData,
      },
    });
    const body = card.body as {
      contents: Array<{
        contents?: Array<{
          action?: { type: string; data?: string; label?: string; text?: string };
        }>;
      }>;
    };
    const actions = body.contents
      .flatMap((row) => row.contents ?? [])
      .flatMap((button) => (button.action ? [button.action] : []));

    expect(actions).toHaveLength(12);
    for (const action of actions) {
      expect(action).toEqual({
        type: "message",
        label: "Unavailable",
        text: "Action unavailable: callback data exceeds LINE's limit.",
      });
    }
  });
});

async function registerCommandWithHandler(
  runHandler: (command: unknown) => Promise<unknown>,
): Promise<unknown> {
  let result: unknown;
  registerLineCardCommand({
    registerCommand(command: unknown) {
      result = runHandler(command);
    },
  } as never);
  return result;
}
