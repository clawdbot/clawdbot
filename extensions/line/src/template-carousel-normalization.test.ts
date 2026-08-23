// Line tests cover provider-valid carousel normalization and fallback behavior.
import { describe, expect, it } from "vitest";
import { messageAction } from "./actions.js";
import {
  buildTemplateMessageFromPayload,
  createCarouselColumn,
  createTemplateCarousel,
} from "./template-messages.js";
import type { LineTemplateMessagePayload } from "./types.js";

type CarouselPayload = Extract<LineTemplateMessagePayload, { type: "carousel" }>;

const action = (label: string) => ({ type: "message" as const, label, data: label });
const column = (
  text: string,
  options?: {
    title?: string;
    thumbnailImageUrl?: string;
    actions?: string[];
  },
): CarouselPayload["columns"][number] => ({
  text,
  title: options?.title,
  thumbnailImageUrl: options?.thumbnailImageUrl,
  actions: (options?.actions ?? ["Open"]).map(action),
});

const invalidCases: Array<{
  name: string;
  columns: CarouselPayload["columns"];
  fallback: string;
}> = [
  {
    name: "mixed titles",
    columns: [column("A", { title: "First" }), column("B")],
    fallback: "First: A (Open)\nB (Open)",
  },
  {
    name: "mixed thumbnails",
    columns: [column("A", { thumbnailImageUrl: "https://example.com/a.jpg" }), column("B")],
    fallback: "A (Open)\nB (Open)",
  },
  {
    name: "unequal action counts",
    columns: [column("A", { actions: ["One", "Two"] }), column("B", { actions: ["Three"] })],
    fallback: "A (One / Two)\nB (Three)",
  },
  {
    name: "an empty action list",
    columns: [column("A", { actions: [] }), column("B")],
    fallback: "A\nB (Open)",
  },
  {
    name: "a blank label that empties one column",
    columns: [column("A", { actions: [""] }), column("B")],
    fallback: "A\nB (Open)",
  },
];

describe("LINE carousel normalization", () => {
  it("leaves a provider-valid carousel byte shape unchanged", () => {
    const columns = [
      createCarouselColumn({
        title: "First",
        text: "A",
        thumbnailImageUrl: "https://example.com/a.jpg",
        actions: [messageAction("One"), messageAction("Two")],
      }),
      createCarouselColumn({
        title: "Second",
        text: "B",
        thumbnailImageUrl: "https://example.com/b.jpg",
        actions: [messageAction("Three"), messageAction("Four")],
      }),
    ];

    expect(createTemplateCarousel(columns, { altText: "Options" })).toEqual({
      type: "template",
      altText: "Options",
      template: {
        type: "carousel",
        columns,
        imageAspectRatio: "rectangle",
        imageSize: "cover",
      },
    });
  });

  it.each(invalidCases)("returns content-preserving text for $name", ({ columns, fallback }) => {
    expect(
      buildTemplateMessageFromPayload({
        type: "carousel",
        columns,
      }),
    ).toEqual({ type: "text", text: fallback });
  });

  it("preserves fallback alt text within the provider limit", () => {
    const altText = "a".repeat(1600);
    expect(
      buildTemplateMessageFromPayload({
        type: "carousel",
        columns: [column("A", { actions: [] })],
        altText,
      }),
    ).toEqual({ type: "text", text: `${"a".repeat(1500)}\nA` });
  });

  it.each(invalidCases)("never emits an invalid carousel for $name", ({ columns }) => {
    const built = columns.map((entry) =>
      createCarouselColumn({
        title: entry.title,
        text: entry.text,
        thumbnailImageUrl: entry.thumbnailImageUrl,
        actions: entry.actions.map((item) => messageAction(item.label, item.data)),
      }),
    );

    expect(() => createTemplateCarousel(built)).toThrow(/LINE carousel/);
  });

  it("filters blank labels before applying the three-action provider cap", () => {
    const message = buildTemplateMessageFromPayload({
      type: "carousel",
      columns: [
        column("A", { actions: ["", "One", "Two", "Three"] }),
        column("B", { actions: ["", "Four", "Five", "Six"] }),
      ],
    });

    expect(message).toMatchObject({
      type: "template",
      template: {
        type: "carousel",
        columns: [
          { actions: [{ label: "One" }, { label: "Two" }, { label: "Three" }] },
          { actions: [{ label: "Four" }, { label: "Five" }, { label: "Six" }] },
        ],
      },
    });
  });

  it("applies the ten-column provider cap after normalization", () => {
    const message = buildTemplateMessageFromPayload({
      type: "carousel",
      columns: Array.from({ length: 11 }, (_, index) => column(`Column ${index + 1}`)),
    });

    expect(message).toMatchObject({
      type: "template",
      template: { type: "carousel" },
    });
    if (message?.type !== "template" || message.template.type !== "carousel") {
      throw new Error("expected carousel");
    }
    expect(message.template.columns).toHaveLength(10);
  });
});
