// Msteams tests cover the controls an agent reply offers on the monitor reply path.
import { SILENT_REPLY_TOKEN } from "openclaw/plugin-sdk/reply-chunking";
import { beforeEach, describe, expect, it } from "vitest";
import type { ReplyPayload } from "../runtime-api.js";
import { renderReplyPayloadsToMessages } from "./messenger.js";
import { installMSTeamsRenderTestRuntime } from "./messenger.test-helpers.js";
import { prepareMSTeamsReplyPayload, readMSTeamsPresentationCard } from "./presentation.js";

const PRESENTATION = {
  title: "Deploy",
  blocks: [
    { type: "text" as const, text: "Finished" },
    { type: "buttons" as const, buttons: [{ label: "Open", value: "open" }] },
  ],
};

const RENDER_OPTIONS = {
  textChunkLimit: 4000,
  tableMode: "code",
} satisfies Parameters<typeof renderReplyPayloadsToMessages>[1];

function renderReply(payload: ReplyPayload) {
  return renderReplyPayloadsToMessages([payload], RENDER_OPTIONS);
}

const cardOf = readMSTeamsPresentationCard;

describe("msteams reply presentation", () => {
  beforeEach(() => {
    installMSTeamsRenderTestRuntime();
  });

  it("carries a reply's buttons into the card the reply path sends", () => {
    // The renderer resolves the portable presentation itself - it is the one place
    // the reply path turns a payload into Teams messages.
    expect(renderReply({ text: "Deploy finished", presentation: PRESENTATION })).toEqual([
      {
        // The card is the whole message; `text` rides along only as the content the
        // delivery record reports, and buildActivity never sends it separately.
        text: "Deploy finished",
        card: {
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: "Deploy finished", wrap: true },
            { type: "TextBlock", text: "Deploy", weight: "Bolder", size: "Medium", wrap: true },
            { type: "TextBlock", text: "Finished", wrap: true },
          ],
          actions: [
            { type: "Action.Submit", title: "Open", data: { value: "open", label: "Open" } },
          ],
        },
      },
    ]);
  });

  it("renders a controls-only reply instead of producing no message at all", () => {
    // Two replies arrive in this shape: one whose only content is its controls, and a
    // streamed reply whose text the stream already delivered. Without a card neither has
    // text or media, so the renderer skipped it and the user saw nothing.
    const messages = renderReply({ presentation: PRESENTATION });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.card?.body).toEqual([
      { type: "TextBlock", text: "Deploy", weight: "Bolder", size: "Medium", wrap: true },
      { type: "TextBlock", text: "Finished", wrap: true },
    ]);
    expect(messages[0]?.card?.actions).toEqual([
      { type: "Action.Submit", title: "Open", data: { value: "open", label: "Open" } },
    ]);
  });

  it("still builds the card when a data-only presentation also offers controls", () => {
    const prepared = prepareMSTeamsReplyPayload({
      text: "Runs by region:\n- EU: 12",
      presentationTextMode: "fallback",
      presentation: {
        blocks: [
          {
            type: "table",
            caption: "Runs by region",
            headers: ["Region", "Runs"],
            rows: [["EU", "12"]],
          },
          { type: "buttons", buttons: [{ label: "Open run", value: "open" }] },
        ],
      },
    });

    // The authored fallback only wins when nothing interactive is left. Keeping the prose
    // here would drop the button - the loss this whole change exists to stop.
    expect(cardOf(prepared)?.actions).toEqual([
      { type: "Action.Submit", title: "Open run", data: { value: "open", label: "Open run" } },
    ]);
  });

  it("keeps the producer's authored fallback for a presentation Teams cannot render", () => {
    const authored = "Runs by region:\n- EU: 12\n- US: 9";
    const prepared = prepareMSTeamsReplyPayload({
      text: authored,
      presentationTextMode: "fallback",
      presentation: {
        blocks: [
          {
            type: "table",
            caption: "Runs by region",
            headers: ["Region", "Runs"],
            rows: [
              ["EU", "12"],
              ["US", "9"],
            ],
          },
        ],
      },
    });

    // Teams cannot render tables, so every block degrades to text and the card would
    // only re-flatten it. Core skips its renderer here to keep the authored fallback
    // verbatim; the reply path has to reach the same answer.
    expect(cardOf(prepared)).toBeUndefined();
    expect(prepared.text).toBe(authored);
  });

  it("degrades the controls to text when the reply carries media", () => {
    const prepared = prepareMSTeamsReplyPayload({
      text: "Deploy finished",
      mediaUrl: "https://example.com/log.png",
      presentation: PRESENTATION,
    });

    // A card and a media attachment cannot share one activity, so the controls become
    // prose rather than disappearing.
    expect(cardOf(prepared)).toBeUndefined();
    expect(prepared.mediaUrl).toBe("https://example.com/log.png");
    expect(prepared.text).toContain("Deploy finished");
    expect(prepared.text).toContain("Open");
  });

  it("does not repeat fallback prose inside the card", () => {
    const prepared = prepareMSTeamsReplyPayload({
      text: "Deploy finished\n\n[Open]",
      presentationTextMode: "fallback",
      presentation: PRESENTATION,
    });

    // "fallback" text is core's prose rendering of these same controls; the card renders
    // them natively, so keeping the prose would show every button twice.
    expect(cardOf(prepared)).toEqual({
      type: "AdaptiveCard",
      version: "1.4",
      body: [
        { type: "TextBlock", text: "Deploy", weight: "Bolder", size: "Medium", wrap: true },
        { type: "TextBlock", text: "Finished", wrap: true },
      ],
      actions: [{ type: "Action.Submit", title: "Open", data: { value: "open", label: "Open" } }],
    });
  });

  it("keeps the text path's chunking when a reply is too long for one card", () => {
    const longText = "x".repeat(5000);

    // A card is one activity and cannot be split, so a reply past the transport limit
    // stays on the chunked text path and its controls degrade to prose. Building one
    // oversized card instead would have Teams reject the whole reply.
    const messages = renderReply({ text: longText, presentation: PRESENTATION });

    expect(messages.every((message) => message.card === undefined)).toBe(true);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.map((message) => message.text ?? "").join("")).toContain("Open");
  });

  it("renders the card's text in the dialect a plain reply would use", () => {
    const table = "| Region | Runs |\n| --- | --- |\n| EU | 12 |";

    // The card path skipped formatMSTeamsMarkdown, so a markdown table reached Teams as
    // raw pipes inside the card while the same reply without controls rendered properly.
    const [plain] = renderReply({ text: table });
    const [carded] = renderReply({ text: table, presentation: PRESENTATION });

    expect(plain?.text).toBeDefined();
    expect(carded?.card?.body).toEqual(
      expect.arrayContaining([{ type: "TextBlock", text: plain?.text, wrap: true }]),
    );
  });

  it("keeps the authored fallback prose when the reply also carries media", () => {
    const prepared = prepareMSTeamsReplyPayload({
      text: "Deploy finished\n\n[Open]",
      presentationTextMode: "fallback",
      mediaUrl: "https://example.com/log.png",
      presentation: PRESENTATION,
    });

    // No card can be built next to media, so the prose the producer authored is the only
    // rendering left; regenerating it would drop whatever wording it chose.
    expect(cardOf(prepared)).toBeUndefined();
    expect(prepared.text).toBe("Deploy finished\n\n[Open]");
  });

  it("maps every button action Teams renders natively", () => {
    const [message] = renderReply({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Open docs", url: "https://example.com/docs" },
              { label: "Retry", action: { type: "command", command: "/retry" } },
              { label: "Open app", action: { type: "web-app", url: "https://example.com/app" } },
              { label: "Approve", value: "approve" },
            ],
          },
        ],
      },
    });

    expect(message?.card?.actions).toEqual([
      { type: "Action.OpenUrl", title: "Open docs", url: "https://example.com/docs" },
      { type: "Action.Submit", title: "Retry", data: "/retry" },
      { type: "Action.OpenUrl", title: "Open app", url: "https://example.com/app" },
      { type: "Action.Submit", title: "Approve", data: { value: "approve", label: "Approve" } },
    ]);
  });

  it("keeps a fallback reply's prose as the delivered content even though the card replaces it", () => {
    const [message] = renderReply({
      text: "Deploy finished\n\n[Open]",
      presentationTextMode: "fallback",
      presentation: PRESENTATION,
    });

    // The card renders these controls natively, so the prose does not go inside it - but
    // the delivery record still has to say what the user was shown.
    expect(message?.text).toBe("Deploy finished\n\n[Open]");
    expect(JSON.stringify(message?.card?.body)).not.toContain("[Open]");
  });

  it("does not turn a silent reply into a card", () => {
    // NO_REPLY is the agent choosing to stay silent. The text path drops it; the card
    // path must not put it in front of the user as the card's first line instead.
    expect(renderReply({ text: SILENT_REPLY_TOKEN, presentation: PRESENTATION })).toEqual([]);
  });

  it("keeps the card's text as the message's delivered content", () => {
    const [message] = renderReply({ text: "Deploy finished", presentation: PRESENTATION });

    // The dispatcher records `text` as what the reply delivered; without it a card-only
    // message reports empty content on the partial-failure path.
    expect(message?.text).toBe("Deploy finished");
    expect(message?.card).toBeDefined();
  });

  it("leaves a reply without a presentation untouched", () => {
    const payload: ReplyPayload = { text: "plain reply" };

    // Same object, not a copy: a plain reply must reach delivery exactly as produced.
    // Its rendering stays on the text path, which messenger.test.ts already covers.
    expect(prepareMSTeamsReplyPayload(payload)).toBe(payload);
  });
});
