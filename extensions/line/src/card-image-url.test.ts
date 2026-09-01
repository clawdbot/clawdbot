import { createServer } from "node:http";
import type { messagingApi } from "@line/bot-sdk";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createActionCard, createImageCard } from "./flex-templates/basic-cards.js";
import { renderLineCard } from "./rich-messages.js";
import { pushMessagesLine, replyMessageLine } from "./send.js";
import { buildTemplateMessageFromPayload } from "./template-messages.js";

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", () => ({
  requireRuntimeConfig: (cfg: unknown) => cfg,
}));
vi.mock("./accounts.js", () => ({
  resolveLineAccount: () => ({ accountId: "default" }),
}));
vi.mock("./channel-access-token.js", () => ({
  resolveLineChannelAccessToken: () => "line-card-wire-test-token",
}));
vi.mock("openclaw/plugin-sdk/channel-activity-runtime", () => ({
  recordChannelActivity: () => {},
}));

type WireRequest = {
  method: string;
  path: string;
  authorization: string;
  body: { to?: string; replyToken?: string; messages: messagingApi.Message[] };
};

const imageUrl = "https://example.com/cover.jpg";
const videoUrl = "https://example.com/clip.mp4";
const image: messagingApi.FlexImage = { type: "image", url: imageUrl };
const action: messagingApi.MessageAction = { type: "message", label: "Choose", text: "choose" };
const caption: messagingApi.FlexBox = {
  type: "box",
  layout: "vertical",
  contents: [{ type: "text", text: "Original caption" }],
};

function videoMessage(
  url: string,
  altContent: messagingApi.FlexComponent,
): messagingApi.FlexMessage {
  return {
    type: "flex",
    altText: "Video card",
    contents: {
      type: "bubble",
      size: "mega",
      hero: { type: "video", url, previewUrl: imageUrl, altContent, aspectRatio: "20:13" },
      body: caption,
    },
  };
}

function bubble(message: messagingApi.Message): messagingApi.FlexBubble {
  if (message.type !== "flex" || message.contents.type !== "bubble") {
    throw new Error("Expected a Flex bubble");
  }
  return message.contents;
}

const cases: Array<{
  name: string;
  message: () => messagingApi.Message;
  verify: (message: messagingApi.Message) => void;
}> = [
  {
    name: "valid video and image alternative remain unchanged",
    message: () => videoMessage(videoUrl, image),
    verify: (message) => expect(message).toEqual(videoMessage(videoUrl, image)),
  },
  {
    name: "valid video retains required alternative when its image URL is invalid",
    message: () => videoMessage(videoUrl, { type: "image", url: "http://example.com/cover.jpg" }),
    verify: (message) => {
      const hero = bubble(message).hero;
      expect(hero).toMatchObject({ type: "video", url: videoUrl, previewUrl: imageUrl });
      if (hero?.type !== "video") {
        throw new Error("Expected preserved video");
      }
      expect(hero.altContent).toMatchObject({
        type: "box",
        layout: "vertical",
        contents: [{ type: "text", text: expect.stringContaining("Image unavailable") }],
      });
      expect(bubble(message).body?.contents[0]).toEqual(caption.contents[0]);
    },
  },
  {
    name: "invalid video URL preserves its valid image alternative",
    message: () => videoMessage("http://example.com/clip.mp4", image),
    verify: (message) => {
      expect(bubble(message).hero).toEqual(image);
      expect(bubble(message).body?.contents[0]).toEqual(caption.contents[0]);
    },
  },
  {
    name: "mixed carousel image URLs retain consistent image presence",
    message: () => ({
      type: "template",
      altText: "Choose an item",
      template: {
        type: "carousel",
        columns: [imageUrl, "http://example.com/cover.jpg"].map((thumbnailImageUrl, index) => ({
          title: `Item ${index + 1}`,
          text: `Caption ${index + 1}`,
          thumbnailImageUrl,
          actions: [action],
        })),
      },
    }),
    verify: (message) => {
      if (message.type !== "template" || message.template.type !== "carousel") {
        throw new Error("Expected a template carousel");
      }
      expect(message.template.columns).toEqual(
        [0, 1].map((index) => ({
          title: `Item ${index + 1}`,
          text: `Caption ${index + 1}`,
          actions: [action],
        })),
      );
    },
  },
];

for (const url of [
  "http://example.com/cover.jpg",
  "ftp://example.com/cover.jpg",
  "cover.jpg",
  "",
]) {
  cases.push({
    name: `omits an image-card hero with unsupported URL ${JSON.stringify(url)}`,
    message: () => ({
      type: "flex",
      altText: "Product",
      contents: createImageCard(url, "Product", "Caption"),
    }),
    verify: (message) => {
      const card = bubble(message);
      expect(card.hero).toBeUndefined();
      expect(card.body?.contents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", text: "Product" }),
          expect.objectContaining({ type: "text", text: "Caption" }),
          expect.objectContaining({ type: "text", text: "Image unavailable: URL must use HTTPS." }),
        ]),
      );
    },
  });
}

cases.push(
  {
    name: "retains valid HTTPS image cards",
    message: () => ({
      type: "flex",
      altText: "Product",
      contents: createImageCard(imageUrl, "Product", "Caption"),
    }),
    verify: (message) =>
      expect(message).toEqual({
        type: "flex",
        altText: "Product",
        contents: createImageCard(imageUrl, "Product", "Caption"),
      }),
  },
  {
    name: "keeps action-card controls when the image is unavailable",
    message: () => ({
      type: "flex",
      altText: "Menu",
      contents: createActionCard("Menu", "Choose", [{ label: "Choose", action }], {
        imageUrl: "http://example.com/cover.jpg",
      }),
    }),
    verify: (message) => {
      const card = bubble(message);
      expect(card.hero).toBeUndefined();
      expect(card.footer?.contents).toEqual([expect.objectContaining({ type: "button", action })]);
    },
  },
  {
    name: "normalizes the typed media-player card at final send",
    message: () => {
      const card = renderLineCard({
        type: "media_player",
        title: "Song",
        imageUrl: "http://example.com/cover.jpg",
      });
      return {
        type: "flex",
        altText: card.altText,
        contents: card.contents as messagingApi.FlexContainer,
      };
    },
    verify: (message) => {
      const card = bubble(message);
      expect(card.hero).toBeUndefined();
      expect(card.body?.contents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", text: "Image unavailable: URL must use HTTPS." }),
        ]),
      );
      expect(card.footer?.contents.length).toBeGreaterThan(0);
    },
  },
  {
    name: "removes nested invalid images and baseline icons without losing their siblings",
    message: () => ({
      type: "flex",
      altText: "Nested media",
      contents: {
        type: "bubble",
        body: {
          type: "box",
          layout: "vertical",
          contents: [
            {
              type: "box",
              layout: "baseline",
              contents: [
                { type: "icon", url: "http://example.com/icon.png" },
                { type: "icon", url: imageUrl },
                { type: "text", text: "Label" },
              ],
            },
            {
              type: "box",
              layout: "vertical",
              contents: [{ type: "image", url: "http://example.com/cover.jpg" }],
            },
            image,
          ],
        },
      },
    }),
    verify: (message) =>
      expect(bubble(message).body?.contents).toEqual([
        {
          type: "box",
          layout: "baseline",
          contents: [
            { type: "icon", url: imageUrl },
            { type: "text", text: "Label" },
          ],
        },
        { type: "box", layout: "vertical", contents: [] },
        image,
        expect.objectContaining({ type: "text", text: "Image unavailable: URL must use HTTPS." }),
      ]),
  },
  {
    name: "scopes image warnings to the affected Flex carousel bubble",
    message: () => ({
      type: "flex",
      altText: "Cards",
      contents: {
        type: "carousel",
        contents: [
          createImageCard("http://example.com/cover.jpg", "First", "Caption"),
          createImageCard(imageUrl, "Second", "Caption"),
        ],
      },
    }),
    verify: (message) => {
      if (message.type !== "flex" || message.contents.type !== "carousel") {
        throw new Error("Expected Flex carousel");
      }
      const first = expectDefined(message.contents.contents[0], "first bubble");
      expect(first.hero).toBeUndefined();
      expect(first.body?.contents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: "Image unavailable: URL must use HTTPS." }),
        ]),
      );
      expect(message.contents.contents[1]).toEqual(createImageCard(imageUrl, "Second", "Caption"));
    },
  },
  {
    name: "invalid video preview uses the existing image alternative",
    message: () => {
      const message = videoMessage(videoUrl, image);
      const hero = bubble(message).hero;
      if (hero?.type !== "video") {
        throw new Error("Expected video fixture");
      }
      hero.previewUrl = "http://example.com/cover.jpg";
      return message;
    },
    verify: (message) => expect(bubble(message).hero).toEqual(image),
  },
  {
    name: "retains a video alternative box when a nested image is removed",
    message: () =>
      videoMessage(videoUrl, {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "Alternative caption" },
          { type: "image", url: "http://example.com/cover.jpg" },
        ],
      }),
    verify: (message) =>
      expect(bubble(message).hero).toMatchObject({
        type: "video",
        url: videoUrl,
        previewUrl: imageUrl,
        altContent: {
          type: "box",
          layout: "vertical",
          contents: [{ type: "text", text: "Alternative caption" }],
        },
      }),
  },
  {
    name: "retains allowed HTTP action links on valid video media",
    message: () => {
      const message = videoMessage(videoUrl, image);
      const hero = bubble(message).hero;
      if (hero?.type !== "video") {
        throw new Error("Expected video fixture");
      }
      hero.action = { type: "uri", label: "Open", uri: "http://example.com/action" };
      return message;
    },
    verify: (message) =>
      expect(bubble(message).hero).toMatchObject({
        type: "video",
        altContent: image,
        action: { type: "uri", label: "Open", uri: "http://example.com/action" },
      }),
  },
);

for (const thumbnailImageUrl of ["http://example.com/cover.jpg", "cover.jpg", imageUrl]) {
  cases.push({
    name: `buttons-template thumbnail ${thumbnailImageUrl}`,
    message: () =>
      expectDefined(
        buildTemplateMessageFromPayload({
          type: "buttons",
          title: "Menu",
          text: "Choose",
          thumbnailImageUrl,
          actions: [{ type: "message", label: "Choose", data: "choose" }],
        }),
        "buttons template",
      ),
    verify: (message) => {
      if (message.type !== "template" || message.template.type !== "buttons") {
        throw new Error("Expected buttons template");
      }
      expect(message.template.thumbnailImageUrl).toBe(
        thumbnailImageUrl === imageUrl ? imageUrl : undefined,
      );
      expect(message.template).toMatchObject({ title: "Menu", text: "Choose", actions: [action] });
    },
  });
}

for (const thumbnails of [
  [imageUrl, imageUrl],
  [undefined, imageUrl],
  ["http://example.com/cover.jpg", "http://example.com/other.jpg"],
]) {
  cases.push({
    name: `carousel thumbnails ${JSON.stringify(thumbnails)}`,
    message: () =>
      expectDefined(
        buildTemplateMessageFromPayload({
          type: "carousel",
          columns: thumbnails.map((thumbnailImageUrl, index) => ({
            title: `Item ${index + 1}`,
            text: `Caption ${index + 1}`,
            thumbnailImageUrl,
            actions: [{ type: "message", label: "Choose", data: "choose" }],
          })),
        }),
        "carousel template",
      ),
    verify: (message) => {
      if (message.type !== "template" || message.template.type !== "carousel") {
        throw new Error("Expected template carousel");
      }
      const allImagesValid = thumbnails.every((url) => url === imageUrl);
      expect(message.template.columns.map((column) => column.thumbnailImageUrl)).toEqual(
        allImagesValid ? thumbnails : [undefined, undefined],
      );
      expect(message.template.columns).toEqual(
        [0, 1].map((index) =>
          expect.objectContaining({
            title: `Item ${index + 1}`,
            text: `Caption ${index + 1}`,
            actions: [action],
          }),
        ),
      );
    },
  });
}

for (const shape of ["bubble", "carousel"] as const) {
  const limit = shape === "bubble" ? 30_000 : 50_000;
  const makeNearLimitCard = (): messagingApi.FlexMessage => {
    const cards = Array.from({ length: shape === "bubble" ? 1 : 2 }, () => ({
      type: "bubble" as const,
      body: {
        type: "box" as const,
        layout: "vertical" as const,
        contents: [
          {
            type: "box" as const,
            layout: "baseline" as const,
            contents: [
              { type: "icon" as const, url: "http://x" },
              { type: "text" as const, text: "Original title" },
            ],
          },
          ...Array.from({ length: 20 }, (_, index) => ({
            type: "text" as const,
            text: `Original caption ${index}: `,
          })),
        ],
      },
      footer: {
        type: "box" as const,
        layout: "vertical" as const,
        contents: [{ type: "button" as const, action }],
      },
    }));
    const contents =
      shape === "bubble"
        ? expectDefined(cards[0], "bubble")
        : { type: "carousel" as const, contents: cards };
    const captions = cards.flatMap((card) =>
      card.body.contents.filter((item) => item.type === "text"),
    );
    let remaining = limit - 50 - Buffer.byteLength(JSON.stringify(contents), "utf8");
    for (const [index, text] of captions.entries()) {
      const bytes = Math.floor(remaining / (captions.length - index));
      text.text += "界".repeat(Math.floor(bytes / 3)) + "x".repeat(bytes % 3);
      remaining -= bytes;
    }
    expect(Buffer.byteLength(JSON.stringify(contents), "utf8")).toBe(limit - 50);
    return { type: "flex", altText: "Near-limit card", contents };
  };
  cases.push({
    name: `keeps a near-limit UTF-8 ${shape} deliverable when removing invalid media`,
    message: makeNearLimitCard,
    verify: (message) => {
      if (message.type !== "flex") {
        throw new Error("Expected a Flex message");
      }
      expect(Buffer.byteLength(JSON.stringify(message.contents), "utf8")).toBeLessThanOrEqual(
        limit,
      );
      const original = makeNearLimitCard().contents;
      const before = original.type === "bubble" ? [original] : original.contents;
      const after =
        message.contents.type === "bubble" ? [message.contents] : message.contents.contents;
      expect(after).toHaveLength(before.length);
      for (const [index, card] of after.entries()) {
        expect(Buffer.byteLength(JSON.stringify(card), "utf8")).toBeLessThanOrEqual(30_000);
        expect(card.body?.contents[0]).toEqual({
          type: "box",
          layout: "baseline",
          contents: [{ type: "text", text: "Original title" }],
        });
        expect(card.body?.contents.slice(1, 21)).toEqual(before[index]?.body?.contents.slice(1));
        expect(card.footer).toEqual(before[index]?.footer);
      }
    },
  });
}

const unchangedMessages: messagingApi.Message[] = [
  { type: "image", originalContentUrl: imageUrl, previewImageUrl: imageUrl },
  { type: "video", originalContentUrl: videoUrl, previewImageUrl: imageUrl },
  { type: "audio", originalContentUrl: "https://example.com/audio.mp3", duration: 1000 },
  {
    type: "template",
    altText: "Pictures",
    template: { type: "image_carousel", columns: [{ imageUrl, action }] },
  },
  { type: "text", text: "Choose", quickReply: { items: [{ type: "action", imageUrl, action }] } },
];
for (const message of unchangedMessages) {
  cases.push({
    name: `retains sibling ${message.type} message media`,
    message: () => message,
    verify: (received) => expect(received).toEqual(message),
  });
}

describe("LINE card shape on the actual push and reply wire", () => {
  let requests: WireRequest[] = [];
  let localOrigin: string;
  let realFetch: typeof globalThis.fetch;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireRequest["body"];
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        authorization: request.headers.authorization ?? "",
        body,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ sentMessages: [{ id: "card-wire-message" }] }));
    });
  });

  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("No loopback TCP address");
    }
    realFetch = globalThis.fetch;
    localOrigin = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    requests = [];
    const fetchLoopback = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        if (url.hostname !== "api.line.me") {
          throw new Error(`Unexpected destination: ${url.hostname}`);
        }
        return realFetch(new URL(url.pathname, localOrigin), init);
      },
      { mock: {} },
    );
    vi.stubGlobal("fetch", fetchLoopback);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    vi.doUnmock("openclaw/plugin-sdk/plugin-config-runtime");
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./channel-access-token.js");
    vi.doUnmock("openclaw/plugin-sdk/channel-activity-runtime");
    vi.resetModules();
  });

  for (const operation of ["push", "reply"] as const) {
    it.each(cases)(`${operation}: $name`, async ({ message, verify }) => {
      const original = message();
      const originalBytes = JSON.stringify(original);
      if (operation === "push") {
        await pushMessagesLine("line:user:UcardWire", [original], { cfg: {} });
      } else {
        await replyMessageLine("card-wire-reply-token", [original], { cfg: {} });
      }
      const request = expectDefined(requests[0], "LINE HTTP request");
      expect(requests).toHaveLength(1);
      expect(request).toMatchObject({
        method: "POST",
        path: `/v2/bot/message/${operation}`,
        authorization: "Bearer line-card-wire-test-token",
      });
      expect(request.body).toMatchObject(
        operation === "push" ? { to: "UcardWire" } : { replyToken: "card-wire-reply-token" },
      );
      expect(JSON.stringify(original)).toBe(originalBytes);
      verify(expectDefined(request.body.messages[0], "LINE wire message"));
    });
  }
});
