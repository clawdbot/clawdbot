// Line tests cover message cards plugin behavior.
import { createServer } from "node:http";
import { messagingApi } from "@line/bot-sdk";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  datetimePickerAction,
  messageAction,
  normalizeLineAction,
  normalizeLineMessageActions,
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
function unavailableLineAction(kind: "Action" | "Link", reason: string): Action {
  return { type: "message", label: "Unavailable", text: `${kind} unavailable: ${reason}` };
}
const unavailableCallback = unavailableLineAction("Action", "callback data exceeds LINE's limit.");
const unavailableLink = unavailableLineAction("Link", "URL exceeds LINE's limit.");
const lineFlexCardCommandScenarios = [
  ["info", (body: string) => `info "Title" "${body}"`],
  ["image", (body: string) => `image "Title" "${body}" --url https://example.test/image.png`],
  ["action", (body: string) => `action "Title" "${body}" --actions "Open|ok"`],
  ["list", (body: string) => `list "Title" "${body}|Description"`],
  ["receipt", (body: string) => `receipt "Title" "${body}:$1" --total "$1"`],
] as const;
const lineFlexCardScenarios = lineFlexCardCommandScenarios.map(([kind, args]) => ({
  kind,
  args,
  expectedAltText: (body: string) => `Title: ${body}${kind === "receipt" ? " $1" : ""}`,
}));

const lineTemplateMessageScenarios = [
  {
    kind: "confirm",
    create: (altText: string) =>
      createConfirmTemplate("q".repeat(300), messageAction("Yes"), messageAction("No"), altText),
    bodyLimit: 240,
  },
  {
    kind: "buttons",
    create: (altText: string) =>
      createButtonTemplate("Menu", "b".repeat(200), [messageAction("Open")], { altText }),
    bodyLimit: 60,
  },
  {
    kind: "carousel",
    create: (altText: string) =>
      createTemplateCarousel(
        [createCarouselColumn({ text: "c".repeat(150), actions: [messageAction("Open")] })],
        { altText },
      ),
    bodyLimit: 120,
  },
  {
    kind: "image carousel",
    create: (altText: string) =>
      createImageCarousel(
        [createImageCarouselColumn("https://example.test/image.png", messageAction("Open"))],
        altText,
      ),
  },
] as const;

async function runLineFlexCardCommand(
  args: string,
): Promise<{ altText: string; contents: messagingApi.FlexContainer }> {
  let result: Promise<unknown> | undefined;
  registerLineCardCommand({
    registerCommand(command: unknown) {
      const { handler } = command as {
        handler: (ctx: { args: string; channel: string }) => Promise<unknown>;
      };
      result = handler({ channel: "line", args });
    },
  } as never);
  return (
    (await result) as {
      channelData: {
        line: { flexMessage: { altText: string; contents: messagingApi.FlexContainer } };
      };
    }
  ).channelData.line.flexMessage;
}

type LineProviderRequest = { path: string; authenticated: boolean; type: string; altText: string };

async function withLineProvider(
  run: (client: messagingApi.MessagingApiClient, requests: LineProviderRequest[]) => Promise<void>,
): Promise<void> {
  const requests: LineProviderRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.once("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages: Array<{ type: string; altText: string }>;
      };
      requests.push({
        path: request.url ?? "",
        authenticated: request.headers.authorization === "Bearer isolated-test-token",
        type: payload.messages[0]?.type ?? "",
        altText: payload.messages[0]?.altText ?? "",
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ sentMessages: [{ id: `card-${requests.length}` }] }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("LINE card provider did not bind a TCP port");
    }
    const client = new messagingApi.MessagingApiClient({
      channelAccessToken: "isolated-test-token",
      baseURL: `http://127.0.0.1:${address.port}`,
    });
    await run(client, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("createConfirmTemplate", () => {
  it("truncates text and drops a split surrogate-pair emoji", () => {
    const longText = "x".repeat(300);
    const template = createConfirmTemplate(longText, messageAction("Yes"), messageAction("No"));
    expect((template.template as { text: string }).text.length).toBe(240);
    const emojiTemplate = createConfirmTemplate(
      `${"x".repeat(1499)}😀`,
      messageAction("Yes"),
      messageAction("No"),
    );
    expect(emojiTemplate.altText).toBe("x".repeat(1499));
    expect(loneHighSurrogate.test(emojiTemplate.altText)).toBe(false);
  });
});

describe("createButtonTemplate", () => {
  it("normalizes missing titles, title bounds, and visible action limits", () => {
    const template = createButtonTemplate(undefined, "Text", [messageAction("OK")]);
    expect(template.altText).toBe("Text");
    expect(template.template).toMatchObject({ type: "buttons", text: "Text" });
    expect(template.template).not.toHaveProperty("title");
    const titleless = createButtonTemplate("", "x".repeat(160), [messageAction("OK")]);
    expect(titleless.template).toMatchObject({ text: "x".repeat(160) });
    const actions = Array.from({ length: 6 }, (_, i) => messageAction(`Button ${i}`));
    const limited = createButtonTemplate("Title", "Text", actions);
    expect((limited.template as { actions: unknown[] }).actions.length).toBe(4);
    const titled = createButtonTemplate("x".repeat(50), "Text", [messageAction("OK")]);
    expect((titled.template as { title: string }).title.length).toBe(40);
  });

  it("drops split surrogate-pair emojis from titles and explicit alternative text", () => {
    // 39 chars + an emoji land the truncation boundary inside the surrogate pair;
    // a raw code-unit slice would keep only the lone high surrogate.
    const template = createButtonTemplate(`${"x".repeat(39)}😀`, "Text", [messageAction("OK")]);
    const title = (template.template as { title: string }).title;

    expect(title).toBe("x".repeat(39));
    expect(loneHighSurrogate.test(title)).toBe(false);
    const altTextTemplate = createButtonTemplate("Title", "Text", [messageAction("OK")], {
      altText: `${"x".repeat(1499)}😀`,
    });
    expect(altTextTemplate.altText).toBe("x".repeat(1499));
    expect(loneHighSurrogate.test(altTextTemplate.altText)).toBe(false);
  });

  it.each([undefined, { thumbnailImageUrl: "https://example.com/thumb.jpg" }])(
    "truncates titled text to 60 characters with thumbnail options %o",
    (options) => {
      const template = createButtonTemplate(
        "Title",
        "x".repeat(100),
        [messageAction("OK")],
        options,
      );
      expect((template.template as { text: string }).text).toHaveLength(60);
    },
  );
});

describe("createCarouselColumn", () => {
  it("limits actions to 3", () => {
    const column = createCarouselColumn({
      text: "Text",
      actions: Array.from({ length: 5 }, (_, index) => messageAction(`A${index + 1}`)),
    });

    expect(column.actions.length).toBe(3);
  });

  it.each([
    { name: "neither title nor image", options: {}, limit: 120 },
    { name: "a title", options: { title: "Title" }, limit: 60 },
    {
      name: "a thumbnail",
      options: { thumbnailImageUrl: "https://example.com/thumb.jpg" },
      limit: 60,
    },
  ])("truncates text to $limit characters with $name", ({ options, limit }) => {
    const column = createCarouselColumn({
      ...options,
      text: "x".repeat(150),
      actions: [messageAction("OK")],
    });

    expect(column.text).toHaveLength(limit);
  });

  it("preserves Unicode boundaries and compact carousel title limits", () => {
    const createColumn = (title: string, text: string) =>
      createCarouselColumn({ title, text, actions: [messageAction("OK")] });
    const title = createColumn(`${"x".repeat(39)}😀`, "Text").title;
    expect(title).toBe("x".repeat(39));
    expect(loneHighSurrogate.test(title ?? "")).toBe(false);
    expect(createColumn("Title", `${"x".repeat(59)}👨‍👩‍👧‍👦after`).text).toBe("x".repeat(59));
    const oversizedGrapheme = createColumn("Title", `😀${"\u0301".repeat(59)}`).text;
    expect(oversizedGrapheme).toHaveLength(60);
    expect(oversizedGrapheme.startsWith("😀")).toBe(true);
    expect(createColumn(" ", "x".repeat(150)).text).toBe("x".repeat(60));
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

  it("preserves image-carousel Unicode bounds and unavailable action labels", () => {
    const template = createImageCarousel(
      [
        createImageCarouselColumn(
          "https://example.com/0.jpg",
          uriAction("Open", `https://example.com/?q=${"x".repeat(1200)}`),
        ),
      ],
      `${"x".repeat(1499)}😀`,
    );
    const column = (template.template as messagingApi.ImageCarouselTemplate).columns[0];

    expect(template.altText).toBe("x".repeat(1499));
    expect(loneHighSurrogate.test(template.altText)).toBe(false);
    expect(column?.action).toEqual(unavailableLink);
    expect(column?.action.label).toHaveLength(11);
  });
});

describe("createProductCarousel", () => {
  it.each([
    { actionLabel: "Buy", actionUrl: "https://shop.com/buy", expectedType: "uri" },
    { actionLabel: "Select", actionData: "product_id=123", expectedType: "postback" },
  ])("uses expected action type for product action", ({ expectedType, ...item }) => {
    const template = createProductCarousel([{ title: "Product", description: "Desc", ...item }]);
    const columns = (template.template as { columns: Array<{ actions: Array<{ type: string }> }> })
      .columns;
    const column = expectDefined(columns[0], "product carousel column");
    expect(expectDefined(column.actions[0], "product carousel action").type).toBe(expectedType);
  });

  it("preserves the complete price when truncating a long description", () => {
    const template = createProductCarousel([
      { title: "Product", description: "x".repeat(59), price: "$12.99" },
    ]);
    const columns = (template.template as { columns: Array<{ text: string }> }).columns;

    const column = expectDefined(columns[0], "priced product carousel column");
    expect(column.text).toBe(`${"x".repeat(53)}\n$12.99`);
    expect(column.text.length).toBe(60);
  });
});

describe("flex cards", () => {
  it("preserves optional footer, image-body, and event fields", () => {
    const info = createInfoCard("Title", "Body", "Footer text");
    const footer = info.footer as { contents: Array<{ text: string }> };
    expect(expectDefined(footer.contents[0], "info-card footer content").text).toBe("Footer text");
    const image = createImageCard("https://example.com/img.jpg", "Title", "Body text");
    const imageBody = image.body as { contents: Array<{ text: string }> };
    expect(imageBody.contents.length).toBe(2);
    expect(expectDefined(imageBody.contents[1], "image-card body content").text).toBe("Body text");
    const event = createEventCard({
      title: "Team Offsite",
      date: "February 15, 2026",
      time: "9:00 AM - 5:00 PM",
      location: "Mountain View Office",
      description: "Annual team building event",
    });
    expect(event.size).toBe("mega");
    expect((event.body as { contents: unknown[] }).contents).toHaveLength(3);
  });

  it("bounds list items, actions, carousel bubbles, and device controls", () => {
    const items = Array.from({ length: 15 }, (_, i) => ({ title: `Item ${i}` }));
    const list = createListCard("List", items);
    const body = list.body as { contents: Array<{ type: string; contents?: unknown[] }> };
    expect((body.contents[2] as { contents: unknown[] }).contents).toHaveLength(8);
    const actions = Array.from({ length: 6 }, (_, i) => ({
      label: `Action ${i}`,
      action: { type: "message" as const, label: `A${i}`, text: `action${i}` },
    }));
    const actionCard = createActionCard("Title", "Body", actions);
    expect((actionCard.footer as { contents: unknown[] }).contents).toHaveLength(4);
    const bubbles = Array.from({ length: 15 }, (_, i) => createInfoCard(`Card ${i}`, `Body ${i}`));
    expect(createCarousel(bubbles).contents).toHaveLength(12);
    const device = createDeviceControlCard({
      deviceName: "Device",
      controls: Array.from({ length: 10 }, (_, i) => ({
        label: `Control ${i}`,
        data: `action=${i}`,
      })),
    });
    expect((device.footer as { contents: unknown[] }).contents.length).toBeLessThanOrEqual(3);
  });
});

describe("LINE message action surface restrictions", () => {
  it.each([
    { type: "camera", label: "Open camera" },
    { type: "cameraRoll", label: "Open camera roll" },
    { type: "location", label: "Share location" },
    { type: "richmenuswitch", label: "Switch", richMenuAliasId: "menu", data: "switch" },
  ] satisfies Action[])("keeps $type on its supported provider surface", (action) => {
    const richMenuOnly = action.type === "richmenuswitch";
    const unavailable = {
      type: "message",
      label: "Unavailable",
      text: `Action unavailable: ${richMenuOnly ? "rich menu switching is only available in rich menus." : "this action is only available in quick replies."}`,
    };
    const quickReply = { items: [{ type: "action", action }] } satisfies messagingApi.QuickReply;
    const flex: messagingApi.Message = {
      type: "flex",
      altText: "Choose",
      contents: {
        type: "bubble",
        body: { type: "box", layout: "vertical", contents: [{ type: "button", action }] },
      },
      quickReply,
    };
    const template: messagingApi.Message = {
      type: "template",
      altText: "Choose",
      template: { type: "buttons", text: "Choose", defaultAction: action, actions: [action] },
      quickReply,
    };
    const [normalizedFlex, normalizedTemplate] = [flex, template].map(normalizeLineMessageActions);
    const expectedQuickReplyAction = richMenuOnly ? unavailable : action;

    expect(normalizedFlex).toMatchObject({
      contents: { body: { contents: [{ action: unavailable }] } },
      quickReply: { items: [{ action: expectedQuickReplyAction }] },
    });
    expect(normalizedTemplate).toMatchObject({
      template: { defaultAction: unavailable, actions: [unavailable] },
      quickReply: { items: [{ action: expectedQuickReplyAction }] },
    });
    expect(normalizeLineAction(action)).toEqual(action);
    if (richMenuOnly) {
      expect(
        normalizeLineMessageActions({ type: "text", text: "Choose", quickReply }),
      ).toMatchObject({
        quickReply: { items: [{ action: unavailable }] },
      });
    }
  });

  it.each([
    { items: [] },
    {},
    { items: [{ type: "action", action: { type: "message", label: " \t ", text: "blank" } }] },
    { items: [{ type: "action" }] },
    ...[null, { length: 1 }, "invalid", 1].map((items) => ({ items: items as never })),
  ] satisfies messagingApi.QuickReply[])(
    "omits provider-invalid empty quick replies",
    (quickReply) => {
      const message: messagingApi.TextMessage = { type: "text", text: "Choose", quickReply };
      expect(normalizeLineMessageActions(message)).toEqual({ type: "text", text: "Choose" });
      expect(message.quickReply).toBe(quickReply);
    },
  );

  it("repairs envelopes and filters malformed actions before retaining 13 valid quick replies", () => {
    const malformed: Action[] = [
      { type: "message", label: "Missing message" },
      { type: "uri", label: "Missing URI" },
      { type: "postback", label: "Missing data" },
      { type: "datetimepicker", label: "Missing data", mode: "date" },
      { type: "datetimepicker", label: "Missing mode", data: "" },
      { type: "datetimepicker", label: "Invalid mode", data: "", mode: "invalid" as never },
    ];
    const repaired = {
      imageUrl: "https://example.com/icon.png",
      action: messageAction("Repaired"),
    };
    const valid = [
      { type: "action" as const, action: postbackAction("Empty data", "") },
      { type: "action" as const, action: datetimePickerAction("Date", "", "date") },
      ...Array.from({ length: 14 }, (_, index) => ({
        type: "action" as const,
        action: messageAction(`Option ${index + 1}`),
      })),
    ];
    const items = [
      null as never,
      { type: "action" as const },
      ...malformed.map((action) => ({ type: "action" as const, action })),
      repaired,
      { ...repaired, type: "unsupported" },
      ...valid,
    ];
    const message: messagingApi.TextMessage = {
      type: "text",
      text: "Choose",
      quickReply: { items },
    };

    expect(normalizeLineMessageActions(message).quickReply?.items).toEqual([
      { ...repaired, type: "action" },
      { ...repaired, type: "action" },
      ...valid.slice(0, 11),
    ]);
    expect(message.quickReply?.items).toBe(items);
  });

  it("prefers modern postback text and upgrades deprecated quick-reply text", () => {
    const action: Action = { type: "postback", label: "Open", data: "open", text: "Legacy" };
    const modern = normalizeLineAction({ ...action, displayText: "Modern" });
    const quickReply = normalizeLineMessageActions({
      type: "text",
      text: "Choose",
      quickReply: { items: [{ type: "action", action }] },
    }).quickReply?.items?.[0]?.action;

    expect(modern).toMatchObject({ data: "open", displayText: "Modern" });
    expect(modern).not.toHaveProperty("text");
    expect(quickReply).toMatchObject({ data: "open", displayText: "Legacy" });
    expect(quickReply).not.toHaveProperty("text");
    expect(normalizeLineAction(action)).toMatchObject({ text: "Legacy" });
  });

  it("enforces provider action contracts while preserving valid controls", () => {
    for (const clipboardText of [undefined, ""]) {
      expect(
        normalizeLineAction({ type: "clipboard", label: "Copy", clipboardText } as Action),
      ).toEqual(unavailableLineAction("Action", "clipboard text must not be empty."));
    }
    expect(
      normalizeLineAction({ type: "clipboard", label: "Copy", clipboardText: " " }),
    ).toMatchObject({ clipboardText: " " });
    for (const uri of ["ftp://example.com", "javascript:alert(1)", "/relative"]) {
      expect(normalizeLineAction({ type: "uri", label: "Open", uri })).toEqual(
        unavailableLineAction("Link", "URL scheme is not supported by LINE."),
      );
    }
    for (const uri of ["http://e.co", "https://e.co", "line://app", "tel:+1"]) {
      expect(normalizeLineAction({ type: "uri", label: "Open", uri })).toMatchObject({ uri });
    }
    for (const type of ["message", "uri", "postback", "datetimepicker"] as const) {
      expect(normalizeLineAction({ type, label: "Missing" } as Action).label).toBe("Unavailable");
    }
    for (const [field, options] of [
      ["fillInText", { fillInText: "hello" }],
      ["inputOption", { inputOption: "unsupported" }],
    ] as const) {
      const action = normalizeLineAction({
        type: "postback",
        label: "Run",
        data: "",
        ...options,
      } as Action);
      expect(action).toMatchObject({ type: "postback", data: "" });
      expect(action).not.toHaveProperty(field);
    }
    const keyboard = {
      ...postbackAction("Run", ""),
      inputOption: "openKeyboard",
      fillInText: "hello",
    } as Action;
    expect(normalizeLineAction(keyboard)).toMatchObject(keyboard);
    for (const [mode, initial] of [
      ["date", "not-a-date"],
      ["time", "25:99"],
    ] as const) {
      const action = datetimePickerAction("Pick", "", mode, { initial });
      expect(action).toMatchObject({ type: "datetimepicker", data: "", mode });
      expect(action).not.toHaveProperty("initial");
    }
    for (const [mode, min, max, valid] of [
      ["date", "2026-06-01", "2026-06-01", false],
      ["time", "06:15", "06:15", false],
      ["datetime", "2026-06-01T06:15", "2026-06-01T06:15", false],
      ["date", "2026-02-01", "2026-01-01", false],
      ["datetime", "2026-06-01T10:00", "2026-06-01t09:00", false],
      ["datetime", "2026-06-01T09:00", "2026-06-01t09:00", false],
      ["datetime", "2026-06-01t09:00", "2026-06-01T10:00", true],
    ] as const) {
      const action = datetimePickerAction("Pick", "", mode, { min, max });
      expect(action).toMatchObject(valid ? { min, max } : { type: "datetimepicker" });
      expect(["min", "max"].map((field) => field in action)).toEqual([valid, valid]);
      expect(datetimePickerAction("Pick", "", mode, { initial: min })).toMatchObject({
        initial: min,
      });
    }
    for (const imageUrl of [
      "http://example.com/icon.png",
      "javascript:bad()",
      `https://e.co/${"x".repeat(2000)}`,
    ]) {
      const items = [{ type: "action" as const, imageUrl, action: messageAction("Keep", "Keep") }];
      expect(
        normalizeLineMessageActions({ type: "text", text: "Choose", quickReply: { items } })
          .quickReply?.items,
      ).toEqual([{ type: "action", action: messageAction("Keep", "Keep") }]);
    }
    const area = { x: 0, y: 0, width: 1, height: 1 };
    for (const [action, externalLink] of [
      [{ type: "uri", label: "Open", linkUri: "ftp://example.com", area }, null],
      [{ type: "clipboard", label: "Copy", clipboardText: "", area }, 1],
      [{ type: "message", label: "Missing text", area }, "invalid"],
      [{ type: "uri", label: "Missing URI", area }, { linkUri: "https://e.co" }],
      [
        { type: "uri", linkUri: "ftp://e.co", area },
        { linkUri: "https://e.co", label: "" },
      ],
      [
        { type: "uri", linkUri: "ftp://e.co", area },
        { linkUri: "https://e.co", label: null },
      ],
      [
        { type: "uri", linkUri: "ftp://e.co", area },
        { linkUri: "https://e.co", label: 1 },
      ],
    ] as Array<[messagingApi.ImagemapAction, unknown]>) {
      const message: messagingApi.ImagemapMessage = {
        type: "imagemap",
        baseUrl: "https://example.com",
        altText: "Choose",
        baseSize: { width: 1040, height: 1040 },
        actions: [action],
        video: {
          originalContentUrl: "https://example.com/video.mp4",
          previewImageUrl: "https://example.com/preview.jpg",
          area,
          externalLink: externalLink as never,
        },
      };
      const normalized = normalizeLineMessageActions(message);
      expect(normalized.actions[0]).toMatchObject({ type: "message", label: "Unavailable", area });
      expect(normalized.actions[1]).toMatchObject({ type: "message", label: "Unavailable", area });
      expect(normalized.video).not.toHaveProperty("externalLink");
    }

    const unlabeled = { type: "uri", uri: "https://example.com" } as Action;
    expect(normalizeLineAction(unlabeled)).toEqual(unlabeled);
    for (const type of ["image", "text", "box", "button"] as const) {
      const malformed = { image: null, text: 1, box: "invalid", button: { type: "bogus" } }[type];
      const message = {
        type: "flex",
        altText: "Tap",
        contents: {
          type: "bubble",
          body: {
            type: "box",
            layout: "vertical",
            contents: [
              { type, action: unlabeled },
              { type, action: malformed },
            ],
          },
        },
      } as messagingApi.Message;
      const bubble = (normalizeLineMessageActions(message) as messagingApi.FlexMessage)
        .contents as {
        body: { contents: Array<{ action: Action }> };
      };
      expect(bubble.body.contents[0]?.action).toEqual(
        type === "button" ? unavailableLineAction("Action", "action label is missing.") : unlabeled,
      );
      expect(bubble.body.contents[1]?.action).toEqual(
        type === "button"
          ? unavailableLineAction("Action", "action type is not supported by LINE.")
          : undefined,
      );
    }
    for (const [template, expected] of [
      [
        { type: "buttons", text: "Tap", actions: [unlabeled] },
        unavailableLineAction("Action", "action label is missing."),
      ],
      [
        { type: "buttons", text: "Tap", actions: [{ type: "bogus" }] },
        unavailableLineAction("Action", "action type is not supported by LINE."),
      ],
      [
        {
          type: "image_carousel",
          columns: [{ imageUrl: "https://e.co/image.png", action: unlabeled }],
        },
        unlabeled,
      ],
      [
        {
          type: "image_carousel",
          columns: [{ imageUrl: "https://e.co/image.png", action: { type: "bogus" } }],
        },
        unavailableLineAction("Action", "action type is not supported by LINE."),
      ],
    ] as const) {
      const message = { type: "template", altText: "Tap", template } as messagingApi.Message;
      const normalized = normalizeLineMessageActions(message) as messagingApi.TemplateMessage;
      const action =
        "actions" in normalized.template
          ? normalized.template.actions[0]
          : normalized.template.columns[0]?.action;
      expect(action).toEqual(expected);
    }
  });
});

describe("action label/data surrogate-safe truncation", () => {
  // 19 ASCII chars + 😀 (U+1F600, two UTF-16 code units) = 21 code units; a raw
  // .slice(0, 20) would keep the first 19 chars plus the lone high surrogate.
  const labelWithEmoji = "1234567890123456789😀";

  it.each([
    { kind: "message emoji", action: messageAction(labelWithEmoji), expected: labelWithEmoji },
    { kind: "message ASCII", action: messageAction("Yes"), expected: "Yes" },
    {
      kind: "URI emoji",
      action: uriAction(labelWithEmoji, "https://example.com"),
      expected: labelWithEmoji,
    },
  ])("$kind preserves labels without splitting surrogate pairs", ({ action, expected }) => {
    expect(action.label).toBe(expected);
    expect(loneHighSurrogate.test(action.label ?? "")).toBe(false);
  });

  it.each([
    { kind: "postback", create: (label: string, data: string) => postbackAction(label, data) },
    {
      kind: "datetime picker",
      create: (label: string, data: string) => datetimePickerAction(label, data, "datetime"),
    },
  ])("$kind preserves grapheme labels but disables overlong callback data", ({ create }) => {
    const exactData = `${"d".repeat(298)}😀`;
    const overlongData = `${"d".repeat(299)}😀`;
    const action = create(labelWithEmoji, "data") as { label: string };
    const exact = create("Label", exactData) as { data: string };

    expect(exactData).toHaveLength(300);
    expect(overlongData).toHaveLength(301);
    expect(action.label).toBe(labelWithEmoji);
    expect(loneHighSurrogate.test(action.label)).toBe(false);
    expect(exact.data).toBe(exactData);
    expect(create("Label", overlongData)).toEqual(unavailableCallback);
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

  it("/card action command visibly disables overlong callback data", async () => {
    const { contents } = await runLineFlexCardCommand(
      `action "Menu" "Body" --actions "${labelWithEmoji}|k=${"d".repeat(297)}😀"`,
    );
    const footer = (contents as { footer: { contents: Array<{ action: Action }> } }).footer;
    expect(expectDefined(footer.contents[0], "LINE flex-message footer action").action).toEqual(
      unavailableCallback,
    );
  });

  it.each(lineFlexCardScenarios)(
    "/card $kind preserves valid Flex alternative text and bounds surrogate pairs",
    async (scenario) => {
      const body = "a".repeat(1200);
      const valid = await runLineFlexCardCommand(scenario.args(body));
      const oversized = await runLineFlexCardCommand(
        scenario.args(`${"a".repeat(1492)}😀 overflow`),
      );

      expect(valid.altText).toBe(scenario.expectedAltText(body));
      expect(oversized.altText).toBe(`Title: ${"a".repeat(1492)}`);
      expect(loneHighSurrogate.test(oversized.altText)).toBe(false);
    },
  );

  it("preserves every Flex card command through the real LINE provider SDK", async () => {
    await withLineProvider(async (client, received) => {
      const body = "a".repeat(1200);

      for (const scenario of lineFlexCardScenarios) {
        const message = await runLineFlexCardCommand(scenario.args(body));
        await client.pushMessage({
          to: "U123",
          messages: [{ type: "flex", altText: message.altText, contents: message.contents }],
        });
      }

      expect(received).toHaveLength(lineFlexCardScenarios.length);
      expect(received.every((request) => request.authenticated)).toBe(true);
      expect(received.every((request) => request.type === "flex")).toBe(true);
      expect(received.map((request) => request.altText)).toEqual(
        lineFlexCardScenarios.map((scenario) => scenario.expectedAltText(body)),
      );
    });
  });

  it.each(lineTemplateMessageScenarios)(
    "preserves valid $kind alternative text and Unicode-safe provider bounds",
    (scenario) => {
      const altText = "a".repeat(1200);
      const message = scenario.create(altText);
      const oversized = scenario.create(`${"a".repeat(1499)}😀 overflow`);

      expect(message.altText).toBe(altText);
      expect(oversized.altText).toBe("a".repeat(1499));
      expect(loneHighSurrogate.test(oversized.altText)).toBe(false);
      if ("bodyLimit" in scenario) {
        const template = message.template as {
          text?: string;
          columns?: Array<{ text?: string }>;
        };
        expect((template.text ?? template.columns?.[0]?.text)?.length).toBe(scenario.bodyLimit);
      }
    },
  );

  it("preserves all template families through real SDK push and reply requests", async () => {
    await withLineProvider(async (client, received) => {
      const altText = "a".repeat(1200);

      for (const scenario of lineTemplateMessageScenarios) {
        const message = scenario.create(altText);
        await client.pushMessage({ to: "U123", messages: [message] });
        await client.replyMessage({ replyToken: "reply-token", messages: [message] });
      }

      expect(received).toHaveLength(lineTemplateMessageScenarios.length * 2);
      expect(received.every((request) => request.authenticated)).toBe(true);
      expect(received.every((request) => request.type === "template")).toBe(true);
      expect(received.every((request) => request.altText === altText)).toBe(true);
      expect(received.filter((request) => request.path.endsWith("/push"))).toHaveLength(4);
      expect(received.filter((request) => request.path.endsWith("/reply"))).toHaveLength(4);
    });
  });

  it("/card receipt preserves a provider-valid Unicode alternative-text boundary", async () => {
    const { altText } = await runLineFlexCardCommand(
      `receipt "R" "${"a".repeat(395)}:😀x" --total "$30"`,
    );
    expect(altText).toBe(`R: ${"a".repeat(395)} 😀x`);
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
    expect(overlongAction).toEqual(unavailableLink);
    for (const altUri of [
      null,
      1,
      "invalid",
      { desktop: null },
      { desktop: 1 },
      { desktop: {} },
      { desktop: `${validUri}x` },
    ]) {
      expect(
        normalizeLineAction({ type: "uri", label: "Open", uri: validUri, altUri } as Action),
      ).toEqual({ type: "uri", label: "Open", uri: validUri });
    }
  });

  it.each([
    {
      action: { type: "uri", label: "Open", uri: `https://e.example/?q=${"u".repeat(1200)}` },
      error: "Link unavailable: URL exceeds LINE's limit.",
    },
    {
      action: { type: "postback", label: "Open", data: `action=open&token=${"x".repeat(300)}` },
      error: "Action unavailable: callback data exceeds LINE's limit.",
    },
  ])(
    "buttons template payload visibly disables invalid $action.type actions",
    ({ action, error }) => {
      const template = buildTemplateMessageFromPayload({
        type: "buttons",
        text: "Pick",
        actions: [action],
      });
      const buttonsTemplate = expectDefined(template, "buttons template message").template as {
        actions: Array<{ type: string; label?: string; text?: string }>;
      };

      expect(buttonsTemplate.actions[0]).toEqual({
        type: "message",
        label: "Unavailable",
        text: error,
      });
    },
  );

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
    const buttons = createButtonTemplate(undefined, "Pick", [oversizedPostback], {
      defaultAction: oversizedUri,
    }).template as {
      actions: Action[];
      defaultAction?: Action;
    };
    expect(buttons.actions).toEqual([unavailableCallback]);
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
    expect(carousel.columns[0]?.actions).toEqual([unavailableCallback]);
    expect(carousel.columns[0]?.defaultAction).toEqual(unavailableLink);

    const unlabeled = { type: "uri", uri: "https://example.com" } as Action;
    for (const action of [unlabeled, null, 1, "invalid", { type: "bogus" }]) {
      for (const template of [
        { type: "buttons", text: "Pick", actions: [messageAction("Keep")], defaultAction: action },
        {
          type: "carousel",
          columns: [{ text: "Pick", actions: [messageAction("Keep")], defaultAction: action }],
        },
      ]) {
        const normalized = normalizeLineMessageActions({
          type: "template",
          altText: "Pick",
          template,
        } as messagingApi.Message) as messagingApi.TemplateMessage;
        const defaultAction =
          normalized.template.type === "buttons"
            ? normalized.template.defaultAction
            : normalized.template.columns[0]?.defaultAction;
        expect(defaultAction).toEqual(action === unlabeled ? unlabeled : undefined);
      }
    }

    const imageCarousel = createImageCarousel([
      { imageUrl: "https://e.example/image.jpg", action: oversizedPostback },
    ]).template as { columns: Array<{ action: Action }> };
    expect(imageCarousel.columns[0]?.action).toEqual(unavailableCallback);
  });

  it("normalizes every length-constrained raw action field", () => {
    const postback = normalizeLineAction({
      type: "postback",
      label: "Open",
      data: "action=open",
      displayText: "d".repeat(301),
    });
    expect(postback).toMatchObject({
      displayText: "d".repeat(300),
    });

    for (const action of [
      { type: "message", label: "Open", text: "x".repeat(301) },
      { type: "postback", label: "Open", data: "action=open", fillInText: "x".repeat(301) },
      { type: "postback", label: "Open", data: "action=open", text: "x".repeat(301) },
    ] satisfies Action[]) {
      expect(normalizeLineAction(action)).toEqual(
        unavailableLineAction("Action", "message text exceeds LINE's limit."),
      );
    }
    const emojiText = "😀".repeat(300);
    expect(messageAction("Open", emojiText)).toMatchObject({ text: emojiText });
    const familyEmoji = "👨‍👩‍👧‍👦";
    expect(truncateLineActionLabel(familyEmoji.repeat(3))).toBe(familyEmoji.repeat(2));
    expect(truncateLineActionLabel(`👩${"‍👩".repeat(10)}`)).toBe("…");
    expect(messageAction("Open", familyEmoji.repeat(43))).toEqual(
      unavailableLineAction("Action", "message text exceeds LINE's limit."),
    );
    expect(messageAction("Open", familyEmoji.repeat(42))).toMatchObject({
      text: familyEmoji.repeat(42),
    });
    expect(
      normalizeLineAction({
        type: "clipboard",
        label: "Copy",
        clipboardText: "x".repeat(1001),
      }),
    ).toEqual(unavailableLineAction("Action", "clipboard text exceeds LINE's limit."));
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
    expect((image.hero as { action?: Action }).action).toEqual(unavailableLink);

    const card = createActionCard("Title", "Body", [{ label: "Open", action: oversizedPostback }]);
    const button = (card.footer as { contents: Array<{ action: Action }> }).contents[0];
    expect(button?.action).toEqual(unavailableCallback);

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
    expect(listBox.contents[0]?.action).toEqual(unavailableCallback);

    const event = createEventCard({
      title: "Event",
      date: "Today",
      action: oversizedUri,
    });
    expect((event.body as { action?: Action }).action).toEqual(unavailableLink);
  });

  it.each([
    {
      kind: "media",
      expectedCount: 5,
      create: (data: string) =>
        createMediaPlayerCard({
          title: "Track",
          controls: { previous: { data }, play: { data }, pause: { data }, next: { data } },
          extraActions: [{ label: "Extra", data }],
        }).footer,
    },
    {
      kind: "device",
      expectedCount: 1,
      create: (data: string) =>
        createDeviceControlCard({ deviceName: "Device", controls: [{ label: "On", data }] }).footer,
    },
    {
      kind: "Apple TV",
      expectedCount: 12,
      create: (data: string) =>
        createAppleTvRemoteCard({
          deviceName: "TV",
          actionData: Object.fromEntries(
            "up down left right select menu home play pause volumeUp volumeDown mute"
              .split(" ")
              .map((action) => [action, data]),
          ) as never,
        }).body,
    },
  ])("$kind controls visibly disable overlong opaque callbacks", ({ create, expectedCount }) => {
    const surface = create(`${"d".repeat(299)}😀`) as {
      contents: Array<{ contents?: Array<{ action?: Action }> }>;
    };
    const actions = surface.contents
      .flatMap((row) => row.contents ?? [])
      .flatMap((button) => (button.action ? [button.action] : []));

    expect(actions).toHaveLength(expectedCount);
    expect(actions).toEqual(Array.from({ length: expectedCount }, () => unavailableCallback));
  });
});
