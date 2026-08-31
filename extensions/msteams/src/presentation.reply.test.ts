// Msteams tests cover the controls an agent reply offers on the monitor reply path.
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
    const prepared = prepareMSTeamsReplyPayload({
      text: "Deploy finished",
      presentation: PRESENTATION,
    });

    expect(cardOf(prepared)).toEqual({
      type: "AdaptiveCard",
      version: "1.4",
      body: [
        { type: "TextBlock", text: "Deploy finished", wrap: true },
        { type: "TextBlock", text: "Deploy", weight: "Bolder", size: "Medium", wrap: true },
        { type: "TextBlock", text: "Finished", wrap: true },
      ],
      actions: [{ type: "Action.Submit", title: "Open", data: { value: "open", label: "Open" } }],
    });
    // The card already carries the text, so it is the whole message - the same shape
    // `sendPayload` produces on the outbound path.
    expect(renderReply(prepared)).toEqual([{ card: cardOf(prepared) }]);
  });

  it("renders a controls-only reply instead of producing no message at all", () => {
    const prepared = prepareMSTeamsReplyPayload({ presentation: PRESENTATION });

    // Without a card this payload has no text and no media, so the renderer skipped it
    // and the dispatcher reported no_visible_result - the user saw nothing.
    const messages = renderReply(prepared);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.card).toBeDefined();
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

  it("leaves a reply without a presentation untouched", () => {
    const payload: ReplyPayload = { text: "plain reply" };

    // Same object, not a copy: a plain reply must reach delivery exactly as produced.
    // Its rendering stays on the text path, which messenger.test.ts already covers.
    expect(prepareMSTeamsReplyPayload(payload)).toBe(payload);
  });
});
