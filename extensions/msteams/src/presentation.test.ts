import { describe, expect, it } from "vitest";
import { buildMSTeamsPresentationCard } from "./presentation.js";

describe("buildMSTeamsPresentationCard", () => {
  it("preserves message text when rendering presentation controls", () => {
    expect(
      buildMSTeamsPresentationCard({
        text: "Deploy finished",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Open", value: "open" }],
            },
          ],
        },
      }),
    ).toEqual({
      type: "AdaptiveCard",
      version: "1.4",
      body: [{ type: "TextBlock", text: "Deploy finished", wrap: true }],
      actions: [{ type: "Action.Submit", title: "Open", data: { value: "open", label: "Open" } }],
    });
  });
});
