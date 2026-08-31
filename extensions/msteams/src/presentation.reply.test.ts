// Msteams tests cover the controls an agent reply offers on the monitor reply path.
import { SILENT_REPLY_TOKEN } from "openclaw/plugin-sdk/reply-chunking";
import { describe, expect, it } from "vitest";
import type { ReplyPayload } from "../runtime-api.js";
import { renderReplyPayloadsToMessages } from "./messenger.js";
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
