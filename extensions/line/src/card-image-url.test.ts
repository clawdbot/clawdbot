// Line tests cover card image URLs LINE refuses to fetch.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { normalizeLineMessageActions } from "./actions.js";
import { createActionCard, createImageCard } from "./flex-templates/basic-cards.js";
import { renderLineCard } from "./rich-messages.js";
import { buildTemplateMessageFromPayload } from "./template-messages.js";

const HTTPS_IMAGE = "https://example.com/cover.jpg";
const WARNING = "Image unavailable: URL must be a public https URL.";

type NormalizedBubble = {
  hero?: { type: string; url?: string };
  body?: { contents?: Array<{ type: string; text?: string }> };
};

function normalizeBubble(contents: unknown): NormalizedBubble {
  const message = normalizeLineMessageActions({
    type: "flex",
    altText: "card",
    contents: contents as never,
  });
  return expectDefined(
    (message as { contents?: NormalizedBubble }).contents,
    "normalized flex bubble",
  );
}

function bubbleNotes(bubble: NormalizedBubble): string[] {
  return (bubble.body?.contents ?? [])
    .filter((entry) => entry.type === "text" && entry.text === WARNING)
    .map((entry) => expectDefined(entry.text, "warning text"));
}

describe("card image URLs the LINE API will not fetch", () => {
  it.each([
    { name: "an insecure scheme", url: "http://example.com/cover.jpg" },
    { name: "a non-HTTP scheme", url: "ftp://example.com/cover.jpg" },
    { name: "text that is not a URL", url: "cover.jpg" },
  ])("drops a card hero built from $name and says so in the card", ({ url }) => {
    // LINE fetches the hero itself and rejects the whole message on a bad URL,
    // so leaving it in costs the reply rather than just the picture.
    const bubble = normalizeBubble(createImageCard(url, "Product", "Check it out"));

    expect(bubble.hero).toBeUndefined();
    expect(bubbleNotes(bubble)).toEqual([WARNING]);
  });

  it("keeps an https card hero and adds no note", () => {
    const bubble = normalizeBubble(createImageCard(HTTPS_IMAGE, "Product", "Check it out"));

    expect(bubble.hero).toMatchObject({ type: "image", url: HTTPS_IMAGE });
    expect(bubbleNotes(bubble)).toEqual([]);
  });

  it("drops the hero an agent-authored card asks for over plain HTTP", () => {
    // The message-tool schema advertises ^https:// for this field, but nothing
    // validates channelData at send time, so the plugin has to hold the line.
    const card = renderLineCard({
      type: "media_player",
      title: "Song",
      imageUrl: "http://example.com/cover.jpg",
    } as Parameters<typeof renderLineCard>[0]);
    const bubble = normalizeBubble(card.contents);

    expect(bubble.hero).toBeUndefined();
    expect(bubbleNotes(bubble)).toEqual([WARNING]);
  });

  it("keeps the buttons of an action card whose hero image is unusable", () => {
    const bubble = normalizeBubble(
      createActionCard(
        "Menu",
        "Choose one",
        [{ label: "Go", action: { type: "message", label: "Go", text: "go" } }],
        {
          imageUrl: "http://example.com/cover.jpg",
        },
      ),
    );

    expect(bubble.hero).toBeUndefined();
    expect(bubbleNotes(bubble)).toEqual([WARNING]);
    expect(JSON.stringify(bubble)).toContain('"text":"go"');
  });

  it.each([
    { name: "an insecure scheme", url: "http://example.com/cover.jpg" },
    { name: "text that is not a URL", url: "cover.jpg" },
  ])("drops a buttons-template thumbnail built from $name", ({ url }) => {
    // Same LINE rejection, different property: template/thumbnailImageUrl. The
    // thumbnail is optional there, so dropping it leaves a deliverable message.
    const message = normalizeLineMessageActions(
      expectDefined(
        buildTemplateMessageFromPayload({
          type: "buttons",
          title: "Menu",
          text: "Choose",
          thumbnailImageUrl: url,
          actions: [{ type: "message", label: "Go", data: "go" }],
        }),
        "buttons template",
      ),
    ) as { template: { thumbnailImageUrl?: string; actions: unknown[] } };

    expect(message.template.thumbnailImageUrl).toBeUndefined();
    expect(message.template.actions).toHaveLength(1);
  });

  it("keeps an https buttons-template thumbnail", () => {
    const message = normalizeLineMessageActions(
      expectDefined(
        buildTemplateMessageFromPayload({
          type: "buttons",
          title: "Menu",
          text: "Choose",
          thumbnailImageUrl: HTTPS_IMAGE,
          actions: [{ type: "message", label: "Go", data: "go" }],
        }),
        "buttons template",
      ),
    ) as { template: { thumbnailImageUrl?: string } };

    expect(message.template.thumbnailImageUrl).toBe(HTTPS_IMAGE);
  });

  it("drops an unusable carousel column thumbnail without dropping the column", () => {
    const message = normalizeLineMessageActions(
      expectDefined(
        buildTemplateMessageFromPayload({
          type: "carousel",
          columns: [
            {
              title: "A",
              text: "one",
              thumbnailImageUrl: "http://example.com/cover.jpg",
              actions: [{ type: "message", label: "Go", data: "go" }],
            },
          ],
        }),
        "carousel template",
      ),
    ) as { template: { columns: Array<{ thumbnailImageUrl?: string; text: string }> } };

    expect(message.template.columns).toHaveLength(1);
    expect(message.template.columns[0]?.thumbnailImageUrl).toBeUndefined();
    expect(message.template.columns[0]?.text).toBe("one");
  });
});
